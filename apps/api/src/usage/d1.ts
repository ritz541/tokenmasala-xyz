import { devices, usageDays, usageEvents, usageRawBatches, usageSourceStats, deviceWatermarks } from "@tokenmaxxing/db";
import { and, eq, sql } from "drizzle-orm";
import { Effect } from "effect";
import { Layer } from "effect";

import { Drizzle } from "../database";
import { RawUsageObjectStore } from "./raw-store";
import { UsageRepository } from "./service";

const makeD1UsageRepository = Effect.fn("makeD1UsageRepository")(function* () {
  const database = yield* Drizzle;
  const rawStore = yield* RawUsageObjectStore;

  return UsageRepository.of({
    checkInDevice: (deviceId, device, service, checkedInAt) =>
      Effect.gen(function* () {
        yield* database.use((db) =>
          db
            .update(devices)
            .set({
              arch: device.arch ?? null,
              lastCheckInAt: checkedInAt,
              name: device.name,
              platform: device.platform,
              ...(service.autoUpdate === undefined
                ? {}
                : {
                    serviceAutoUpdateAttemptedAt: optionalDate(service.autoUpdate.attemptedAt),
                    serviceAutoUpdateCompletedAt: optionalDate(service.autoUpdate.completedAt),
                    serviceAutoUpdateCurrentVersion: service.autoUpdate.currentVersion ?? null,
                    serviceAutoUpdateEnabled: service.autoUpdate.enabled,
                    serviceAutoUpdateError: service.autoUpdate.error ?? null,
                    serviceAutoUpdateInstalledVersion: service.autoUpdate.installedVersion ?? null,
                    serviceAutoUpdateLatestVersion: service.autoUpdate.latestVersion ?? null,
                    serviceAutoUpdateManager: service.autoUpdate.manager,
                    serviceAutoUpdateReason: service.autoUpdate.reason,
                    serviceAutoUpdateStatus: service.autoUpdate.status,
                  }),
              serviceBackend: service.backend ?? null,
              serviceError: service.error ?? null,
              serviceReloadRequired: service.reloadRequired ?? null,
              serviceRepairAttemptedAt: optionalDate(service.repairAttemptedAt),
              serviceRepairCompletedAt: optionalDate(service.repairCompletedAt),
              serviceRepairError: service.repairError ?? null,
              serviceRepairReason: service.repairReason ?? null,
              serviceRepairStatus: service.repairStatus ?? null,
              serviceRunnerTarget: service.runnerTarget ?? null,
              serviceRunnerVersion: service.runnerVersion ?? null,
              serviceSchedulerActive: service.schedulerActive ?? null,
              serviceStatus: service.status,
              serviceTemplateVersion: service.templateVersion ?? null,
              version: device.version ?? null,
            })
            .where(eq(devices.id, deviceId)),
        );
      }),
    upsertChunk: (userId, deviceId, rows, syncedAt) =>
      Effect.gen(function* () {
        if (rows.length === 0) {
          return;
        }

        yield* database.use((db) => {
          const statements = rows.map((row) =>
            db
              .insert(usageDays)
              .values({
                deviceId,
                userId,
                date: row.date,
                source: row.source,
                model: row.model,
                inputTokens: row.inputTokens,
                outputTokens: row.outputTokens,
                cacheCreationTokens: row.cacheCreationTokens,
                cacheReadTokens: row.cacheReadTokens,
                totalTokens: row.totalTokens,
                costUsd: row.costUsd,
                syncedAt,
              })
              .onConflictDoUpdate({
                target: [usageDays.deviceId, usageDays.date, usageDays.source, usageDays.model],
                set: {
                  userId,
                  inputTokens: row.inputTokens,
                  outputTokens: row.outputTokens,
                  cacheCreationTokens: row.cacheCreationTokens,
                  cacheReadTokens: row.cacheReadTokens,
                  totalTokens: row.totalTokens,
                  costUsd: row.costUsd,
                  syncedAt,
                },
              }),
          );
          const [first, ...rest] = statements;

          return db.batch([first!, ...rest]);
        });
      }),
    touchDevice: (deviceId, device, syncedAt) =>
      Effect.gen(function* () {
        yield* database.use((db) =>
          db
            .update(devices)
            .set({
              arch: device.arch ?? null,
              lastSyncAt: syncedAt,
              name: device.name,
              platform: device.platform,
              version: device.version ?? null,
            })
            .where(eq(devices.id, deviceId)),
        );
      }),
    upsertSourceStats: (userId, deviceId, stats, syncedAt) =>
      Effect.gen(function* () {
        if (stats.length === 0) {
          return;
        }

        yield* database.use((db) => {
          const statements = stats.map((stat) =>
            db
              .insert(usageSourceStats)
              .values({
                deviceId,
                userId,
                source: stat.source,
                sessionCount: stat.sessionCount,
                syncedAt,
              })
              .onConflictDoUpdate({
                target: [usageSourceStats.deviceId, usageSourceStats.source],
                set: {
                  userId,
                  sessionCount: stat.sessionCount,
                  syncedAt,
                },
              }),
          );
          const [first, ...rest] = statements;

          return db.batch([first!, ...rest]);
        });
      }),
    upsertRawReports: (userId, deviceId, reports, capturedAt) =>
      Effect.gen(function* () {
        if (reports.length === 0) {
          return;
        }

        for (const report of reports) {
          yield* rawStore.putObject({
            key: report.objectKey,
            payloadBytes: report.payloadBytes,
            payloadHash: report.payloadHash,
            payloadJson: report.payloadJson,
          });
        }

        yield* database.use((db) => {
          const statements = reports.map((report) =>
            db
              .insert(usageRawBatches)
              .values({
                id: report.id,
                userId,
                deviceId,
                source: report.source,
                reportKind: report.reportKind,
                ccusageCommand: report.ccusageCommand,
                payloadHash: report.payloadHash,
                objectKey: report.objectKey,
                payloadBytes: report.payloadBytes,
                capturedAt,
                processedAt: report.processedAt,
                parserVersion: report.parserVersion,
              })
              .onConflictDoUpdate({
                target: usageRawBatches.id,
                set: {
                  userId,
                  source: report.source,
                  reportKind: report.reportKind,
                  ccusageCommand: report.ccusageCommand,
                  payloadHash: report.payloadHash,
                  objectKey: report.objectKey,
                  payloadBytes: report.payloadBytes,
                  capturedAt,
                  processedAt: report.processedAt,
                  parserVersion: report.parserVersion,
                },
              }),
          );
          const [first, ...rest] = statements;

          return db.batch([first!, ...rest]);
        });
      }),
    insertEvents: (userId, deviceId, events, syncedAt) =>
      Effect.gen(function* () {
        if (events.length === 0) {
          return { stored: 0 };
        }

        // Server-authoritative watermark: read the newest event ts already
        // counted per (device, source). Events at or before it are re-sends and
        // are dropped — this is what keeps totals from ever decreasing, even if
        // a client wipes its local cache and re-syncs from scratch.
        const watermarkBySource = yield* database.use((db) =>
          db
            .select({ lastEventTs: deviceWatermarks.lastEventTs, source: deviceWatermarks.source })
            .from(deviceWatermarks)
            .where(eq(deviceWatermarks.deviceId, deviceId)),
        );
        // lastEventTs is a Date (timestamp_ms mode); keep the numeric ms in the
        // watermark map so the per-event `event.ts > watermark` comparison works.
        const watermark = new Map<string, number>();
        for (const row of watermarkBySource) {
          watermark.set(row.source, row.lastEventTs.getTime());
        }

        const fresh = events.filter(
          (event) => event.ts > (watermark.get(event.source) ?? 0),
        );
        if (fresh.length === 0) {
          return { stored: 0 };
        }

        const newWatermarkBySource = new Map<string, number>(watermark);
        for (const event of fresh) {
          const current = newWatermarkBySource.get(event.source) ?? 0;
          if (event.ts > current) {
            newWatermarkBySource.set(event.source, event.ts);
          }
        }

        yield* database.use((db) => {
          const eventRows: (typeof usageEvents.$inferInsert)[] = fresh.map((event) => ({
            createdAt: syncedAt,
            date: event.date,
            deviceId,
            id: event.id,
            inputTokens: event.inputTokens,
            model: event.model,
            outputTokens: event.outputTokens,
            cacheCreationTokens: event.cacheCreationTokens,
            cacheReadTokens: event.cacheReadTokens,
            source: event.source,
            totalTokens: event.totalTokens,
            ts: new Date(event.ts),
            userId,
            costUsd: event.costUsd,
          }));

          const eventStatements = eventRows.map((row) =>
            db.insert(usageEvents).values(row),
          );

          // Additive update of the daily aggregate: totals only ever increase.
          const dayStatements = fresh.map((event) =>
            db
              .insert(usageDays)
              .values({
                cacheCreationTokens: event.cacheCreationTokens,
                cacheReadTokens: event.cacheReadTokens,
                costUsd: event.costUsd,
                date: event.date,
                deviceId,
                inputTokens: event.inputTokens,
                model: event.model,
                outputTokens: event.outputTokens,
                source: event.source,
                totalTokens: event.totalTokens,
                userId,
                syncedAt,
              })
              .onConflictDoUpdate({
                target: [usageDays.deviceId, usageDays.date, usageDays.source, usageDays.model],
                set: {
                  cacheCreationTokens: sql`${usageDays.cacheCreationTokens} + excluded.${usageDays.cacheCreationTokens}`,
                  cacheReadTokens: sql`${usageDays.cacheReadTokens} + excluded.${usageDays.cacheReadTokens}`,
                  costUsd: sql`${usageDays.costUsd} + excluded.${usageDays.costUsd}`,
                  inputTokens: sql`${usageDays.inputTokens} + excluded.${usageDays.inputTokens}`,
                  outputTokens: sql`${usageDays.outputTokens} + excluded.${usageDays.outputTokens}`,
                  totalTokens: sql`${usageDays.totalTokens} + excluded.${usageDays.totalTokens}`,
                  syncedAt,
                  userId,
                },
              }),
          );

          const watermarkStatements = [...newWatermarkBySource.entries()].map(
            ([source, lastEventTs]) =>
              db
                .insert(deviceWatermarks)
                .values({ deviceId, source, lastEventTs: new Date(lastEventTs), updatedAt: syncedAt })
                .onConflictDoUpdate({
                  target: [deviceWatermarks.deviceId, deviceWatermarks.source],
                  set: {
                    lastEventTs: new Date(lastEventTs),
                    updatedAt: syncedAt,
                  },
                }),
          );

          const [firstEvent, ...restEvents] = eventStatements;
          const [firstDay, ...restDays] = dayStatements;
          const [firstWatermark, ...restWatermarks] = watermarkStatements;

          return db.batch([
            firstEvent!,
            ...restEvents,
            firstDay!,
            ...restDays,
            firstWatermark!,
            ...restWatermarks,
          ]);
        });

        return { stored: fresh.length };
      }),
  });
});

const UsageRepositoryLive = Layer.effect(UsageRepository, makeD1UsageRepository());

function optionalDate(value: string | null | undefined): Date | null {
  if (value === undefined || value === null) {
    return null;
  }

  const date = new Date(value);

  return Number.isFinite(date.getTime()) ? date : null;
}

export { UsageRepositoryLive };
