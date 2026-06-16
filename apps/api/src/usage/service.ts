import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { DeviceMissing } from "@tokenmaxxing/api-contract";
import type { CliIdentity, SourceUsageStatsInput, UsageDayInput } from "@tokenmaxxing/api-contract";

import type { DatabaseError } from "../database";

/**
 * Usage ingestion: idempotent upserts keyed (deviceId, date, source, model),
 * last write wins. The deviceId always comes from the presenting token —
 * payloads cannot write into another device's history.
 */

interface SyncResult {
  received: number;
  syncedAt: string;
  upserted: number;
}

interface UsageServiceShape {
  syncBatch(
    identity: typeof CliIdentity.Type,
    device: { name: string; platform: string },
    days: readonly UsageDayInput[],
    sourceStats?: readonly SourceUsageStatsInput[],
  ): Effect.Effect<SyncResult, DeviceMissing, any>;
}

interface UsageRepositoryShape {
  /** One db.batch of single-row upserts (D1 binds ~100 params/statement). */
  upsertChunk(
    userId: string,
    deviceId: string,
    rows: readonly UsageDayInput[],
    syncedAt: Date,
  ): Effect.Effect<void, DatabaseError, any>;
  touchDevice(
    deviceId: string,
    device: { name: string; platform: string },
    syncedAt: Date,
  ): Effect.Effect<void, DatabaseError, any>;
  upsertSourceStats(
    userId: string,
    deviceId: string,
    stats: readonly SourceUsageStatsInput[],
    syncedAt: Date,
  ): Effect.Effect<void, DatabaseError, any>;
}

class UsageService extends Context.Service<UsageService, UsageServiceShape>()(
  "@tokenmaxxing/api/UsageService",
) {}

class UsageRepository extends Context.Service<UsageRepository, UsageRepositoryShape>()(
  "@tokenmaxxing/api/UsageRepository",
) {}

const UPSERT_CHUNK_SIZE = 40;

const makeUsageService = Effect.fn("makeUsageService")(function* () {
  const repository = yield* UsageRepository;

  return UsageService.of({
    syncBatch: Effect.fn("UsageService.syncBatch")(function* (
      identity,
      device,
      days,
      sourceStats = [],
    ) {
      const deviceId = identity.deviceId;
      if (deviceId === null) {
        return yield* Effect.fail(
          new DeviceMissing({
            message: "This token has no device; run `tokenmaxxing login` to mint a new one.",
          }),
        );
      }

      const syncedAt = new Date();
      for (let offset = 0; offset < days.length; offset += UPSERT_CHUNK_SIZE) {
        yield* repository
          .upsertChunk(
            identity.user.id,
            deviceId,
            days.slice(offset, offset + UPSERT_CHUNK_SIZE),
            syncedAt,
          )
          .pipe(Effect.orDie);
      }
      yield* repository
        .upsertSourceStats(identity.user.id, deviceId, sourceStats, syncedAt)
        .pipe(Effect.orDie);
      yield* repository.touchDevice(deviceId, device, syncedAt).pipe(Effect.orDie);

      return {
        received: days.length,
        syncedAt: syncedAt.toISOString(),
        upserted: days.length,
      };
    }),
  });
});

const UsageServiceLive = Layer.effect(UsageService, makeUsageService());

export { makeUsageService, UsageRepository, UsageService, UsageServiceLive };

export type { SyncResult, UsageRepositoryShape, UsageServiceShape };
