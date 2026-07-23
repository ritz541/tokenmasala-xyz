import {
  devices,
  usageDays,
  usageEvents,
  usageGithubDays,
  usageRawBatches,
  usageSessions,
  usageSourceStats,
  deviceWatermarks,
} from "@tokenmaxxing/db";
import { and, eq, inArray, sql } from "drizzle-orm";
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

        // Monotone-max reconciliation for SNAPSHOT data. ccusage emits a
        // full daily total per (date, model) on every sync — not a delta. A
        // client that clears its local cache and re-scans will re-send a
        // recomputed (often smaller) total. A last-write-wins upsert would
        // OVERWRITE the larger stored total and the leaderboard would drop.
        // `max(...)` (SQLite scalar fn) keeps every column monotone
        // non-decreasing under any
        // re-send / cache-clear / clock-replay, and is idempotent (sending
        // the same snapshot is a no-op). This is the correct permanent
        // invariant for a snapshot-backed leaderboard; the append-only
        // `usageEvents` log (POST /usage/events) is the audit/live-feed
        // trail and is folded separately by additive deltas.
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
                  cacheCreationTokens: sql`max(${usageDays.cacheCreationTokens}, excluded.cache_creation_tokens)`,
                  cacheReadTokens: sql`max(${usageDays.cacheReadTokens}, excluded.cache_read_tokens)`,
                  costUsd: sql`max(${usageDays.costUsd}, excluded.cost_usd)`,
                  inputTokens: sql`max(${usageDays.inputTokens}, excluded.input_tokens)`,
                  outputTokens: sql`max(${usageDays.outputTokens}, excluded.output_tokens)`,
                  totalTokens: sql`max(${usageDays.totalTokens}, excluded.total_tokens)`,
                  syncedAt,
                  userId,
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

        const fresh = events.filter((event) => event.ts > (watermark.get(event.source) ?? 0));
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

          const eventStatements = eventRows.map((row) => db.insert(usageEvents).values(row));

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
                  cacheCreationTokens: sql`${usageDays.cacheCreationTokens} + excluded.cache_creation_tokens`,
                  cacheReadTokens: sql`${usageDays.cacheReadTokens} + excluded.cache_read_tokens`,
                  costUsd: sql`${usageDays.costUsd} + excluded.cost_usd`,
                  inputTokens: sql`${usageDays.inputTokens} + excluded.input_tokens`,
                  outputTokens: sql`${usageDays.outputTokens} + excluded.output_tokens`,
                  totalTokens: sql`${usageDays.totalTokens} + excluded.total_tokens`,
                  syncedAt,
                  userId,
                },
              }),
          );

          const watermarkStatements = [...newWatermarkBySource.entries()].map(
            ([source, lastEventTs]) =>
              db
                .insert(deviceWatermarks)
                .values({
                  deviceId,
                  source,
                  lastEventTs: new Date(lastEventTs),
                  updatedAt: syncedAt,
                })
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
    insertSessions: (userId, deviceId, sessions, syncedAt) =>
      Effect.gen(function* () {
        if (sessions.length === 0) {
          return { stored: 0 };
        }

        // Lossless, cache-clear-safe ingestion. ccusage emits one row per
        // session with a STABLE session id (data[].session). We fold each
        // session into usageDays exactly once — the first time we see its id.
        // This makes totals both non-decreasing AND exact: a cleared local
        // cache cannot drop history (the dedup row lives on the server), and
        // new work done after a clear is ADDED, never clamped. The daily
        // upsertChunk (max()) remains a safety floor for the snapshot path.
        const byKey = new Map<string, (typeof sessions)[number]>();
        for (const session of sessions) {
          byKey.set(`${session.source} ${session.sessionId}`, session);
        }

        // 1. Which of these session ids are already recorded?
        const incomingSessionIds = [...new Set(sessions.map((s) => s.sessionId))];
        const incomingSources = [...new Set(sessions.map((s) => s.source))];
        const existing = yield* database.use((db) =>
          db
            .select({ source: usageSessions.source, sessionId: usageSessions.sessionId })
            .from(usageSessions)
            .where(
              and(
                eq(usageSessions.deviceId, deviceId),
                inArray(usageSessions.source, incomingSources),
                inArray(usageSessions.sessionId, incomingSessionIds),
              ),
            ),
        );
        for (const row of existing) {
          byKey.delete(`${row.source} ${row.sessionId}`);
        }
        const fresh = [...byKey.values()];
        if (fresh.length === 0) {
          return { stored: 0 };
        }

        yield* database.use((db) => {
          const sessionRows = fresh.map((session) =>
            db.insert(usageSessions).values({
              createdAt: syncedAt,
              date: session.date,
              deviceId,
              lastActivity: new Date(session.lastActivity),
              sessionId: session.sessionId,
              source: session.source,
              userId,
            }),
          );

          // 2. Additively fold the NEW sessions into usageDays. Each session
          //    targets its own (date, model) bucket; totals strictly increase.
          const dayStatements = fresh.map((session) =>
            db
              .insert(usageDays)
              .values({
                cacheCreationTokens: session.cacheCreationTokens,
                cacheReadTokens: session.cacheReadTokens,
                costUsd: session.costUsd,
                date: session.date,
                deviceId,
                inputTokens: session.inputTokens,
                model: session.model,
                outputTokens: session.outputTokens,
                source: session.source,
                totalTokens: session.totalTokens,
                userId,
                syncedAt,
              })
              .onConflictDoUpdate({
                target: [usageDays.deviceId, usageDays.date, usageDays.source, usageDays.model],
                set: {
                  cacheCreationTokens: sql`${usageDays.cacheCreationTokens} + excluded.cache_creation_tokens`,
                  cacheReadTokens: sql`${usageDays.cacheReadTokens} + excluded.cache_read_tokens`,
                  costUsd: sql`${usageDays.costUsd} + excluded.cost_usd`,
                  inputTokens: sql`${usageDays.inputTokens} + excluded.input_tokens`,
                  outputTokens: sql`${usageDays.outputTokens} + excluded.output_tokens`,
                  totalTokens: sql`${usageDays.totalTokens} + excluded.total_tokens`,
                  syncedAt,
                  userId,
                },
              }),
          );

          const [firstSession, ...restSessions] = sessionRows;
          const [firstDay, ...restDays] = dayStatements;

          return db.batch([firstSession!, ...restSessions, firstDay!, ...restDays]);
        });

        return { stored: fresh.length };
      }),
    upsertGithubDays: (userId, deviceId, days, syncedAt) =>
      Effect.gen(function* () {
        if (days.length === 0) {
          return { upserted: 0 };
        }

        yield* database.use((db) => {
          const statements = days.map((day) =>
            db
              .insert(usageGithubDays)
              .values({
                additions: day.additions,
                commitCount: day.commitCount,
                date: day.date,
                deletions: day.deletions,
                deviceId,
                prCount: day.prCount,
                pushCount: day.pushCount,
                syncedAt,
                userId,
              })
              .onConflictDoUpdate({
                target: [usageGithubDays.deviceId, usageGithubDays.date],
                set: {
                  additions: sql`max(${usageGithubDays.additions}, excluded.additions)`,
                  commitCount: sql`max(${usageGithubDays.commitCount}, excluded.commit_count)`,
                  deletions: sql`max(${usageGithubDays.deletions}, excluded.deletions)`,
                  prCount: sql`max(${usageGithubDays.prCount}, excluded.pr_count)`,
                  pushCount: sql`max(${usageGithubDays.pushCount}, excluded.push_count)`,
                  syncedAt,
                  userId,
                },
              }),
          );

          const [first, ...rest] = statements;
          return db.batch([first!, ...rest]);
        });

        return { upserted: days.length };
      }),
    getPresenceDevices: (userId) =>
      Effect.gen(function* () {
        const rows = yield* database.use((db) =>
          db.select().from(devices).where(eq(devices.userId, userId)),
        );

        const ONLINE_WINDOW_MS = 15 * 60 * 1000;
        const now = Date.now();

        return rows.map((device) => {
          const lastActivity = Math.max(
            device.lastCheckInAt?.getTime() ?? 0,
            device.lastSyncAt?.getTime() ?? 0,
          );
          const isOnline = lastActivity > 0 && now - lastActivity <= ONLINE_WINDOW_MS;

          return {
            arch: device.arch ?? null,
            id: device.id,
            isOnline,
            lastCheckInAt: device.lastCheckInAt?.toISOString() ?? null,
            lastSyncAt: device.lastSyncAt?.toISOString() ?? null,
            name: device.name,
            platform: device.platform,
            version: device.version ?? null,
          };
        });
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
