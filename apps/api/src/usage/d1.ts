import { devices, usageDays, usageSourceStats } from "@tokenmaxxing/db";
import { eq } from "drizzle-orm";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { Drizzle } from "../database";
import { UsageRepository } from "./service";

const makeD1UsageRepository = Effect.fn("makeD1UsageRepository")(function* () {
  const database = yield* Drizzle;

  return UsageRepository.of({
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
            .set({ lastSyncAt: syncedAt, name: device.name, platform: device.platform })
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
  });
});

const UsageRepositoryLive = Layer.effect(UsageRepository, makeD1UsageRepository());

export { makeD1UsageRepository, UsageRepositoryLive };
