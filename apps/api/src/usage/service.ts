import { Context } from "effect";
import { Effect } from "effect";

import { DeviceMissing } from "@tokenmaxxing/api-contract";
import type {
  CliIdentity,
  RawUsageReportInput,
  ServiceAutoUpdateManagerValue,
  ServiceAutoUpdateReasonValue,
  ServiceAutoUpdateStatusValue,
  ServiceCheckInStatusValue,
  ServiceRepairReasonValue,
  ServiceRepairStatusValue,
  SourceUsageStatsInput,
  UsageDayInput,
  UsageEventInput,
  UsageSessionInput,
  UsageGithubDayInput,
  PresenceDeviceSummary,
} from "@tokenmaxxing/api-contract";

import { sha256Hex } from "../auth/crypto";
import type { DatabaseError } from "../database";
import { parseRawUsageReports, PARSER_VERSION, type PersistableDailyReport } from "./ccusage";
import { normalizeUsageDays } from "./models";
import type { RawUsageStorageError } from "./raw-store";

/**
 * Usage ingestion: normalized daily reports are stored first, then current
 * structured rows and aggregate source stats are upserted idempotently.
 * Legacy session reports are counted in memory and never persisted. The
 * deviceId always comes from the presenting token, so payloads cannot write
 * into another device's history.
 */

interface SyncResult {
  received: number;
  syncedAt: string;
  upserted: number;
}

interface StoredRawUsageReport {
  ccusageCommand: string;
  id: string;
  objectKey: string;
  parserVersion: string;
  payloadBytes: number;
  payloadHash: string;
  payloadJson: string;
  processedAt: Date;
  reportKind: "daily";
  source: string;
}

interface UsageServiceShape {
  checkIn(
    identity: typeof CliIdentity.Type,
    device: UsageDevice,
    service: UsageServiceCheckIn,
  ): Effect.Effect<{ checkedInAt: string }, DeviceMissing, any>;
  ingestRaw(
    identity: typeof CliIdentity.Type,
    device: UsageDevice,
    reports: readonly RawUsageReportInput[],
    sourceStats?: readonly SourceUsageStatsInput[],
  ): Effect.Effect<SyncResult, DeviceMissing, any>;
  syncBatch(
    identity: typeof CliIdentity.Type,
    device: UsageDevice,
    days: readonly UsageDayInput[],
    sourceStats?: readonly SourceUsageStatsInput[],
  ): Effect.Effect<SyncResult, DeviceMissing, any>;
  ingestEvents(
    identity: typeof CliIdentity.Type,
    device: UsageDevice,
    events: readonly UsageEventInput[],
  ): Effect.Effect<{ received: number; stored: number; syncedAt: string }, DeviceMissing, any>;
  ingestSessions(
    identity: typeof CliIdentity.Type,
    device: UsageDevice,
    sessions: readonly UsageSessionInput[],
  ): Effect.Effect<{ received: number; stored: number; syncedAt: string }, DeviceMissing, any>;
  ingestGithub(
    identity: typeof CliIdentity.Type,
    device: UsageDevice,
    days: readonly UsageGithubDayInput[],
  ): Effect.Effect<{ received: number; upserted: number; syncedAt: string }, DeviceMissing, any>;
  getPresence(
    userId: string,
  ): Effect.Effect<{ devices: PresenceDeviceSummary[] }, DatabaseError, any>;
}

interface UsageDevice {
  arch?: string | undefined;
  name: string;
  platform: string;
  version?: string | undefined;
}

interface UsageServiceCheckIn {
  autoUpdate?: UsageServiceAutoUpdate | undefined;
  backend?: string | undefined;
  error?: string | undefined;
  reloadRequired?: boolean | undefined;
  repairAttemptedAt?: string | undefined;
  repairCompletedAt?: string | undefined;
  repairError?: string | undefined;
  repairReason?: ServiceRepairReasonValue | undefined;
  repairStatus?: ServiceRepairStatusValue | undefined;
  runnerTarget?: string | undefined;
  runnerVersion?: string | undefined;
  schedulerActive?: boolean | undefined;
  status: ServiceCheckInStatusValue;
  templateVersion?: number | undefined;
}

interface UsageServiceAutoUpdate {
  attemptedAt?: string | null | undefined;
  completedAt?: string | null | undefined;
  currentVersion?: string | null | undefined;
  enabled: boolean;
  error?: string | null | undefined;
  installedVersion?: string | null | undefined;
  latestVersion?: string | null | undefined;
  manager: ServiceAutoUpdateManagerValue | null;
  reason: ServiceAutoUpdateReasonValue | null;
  status: ServiceAutoUpdateStatusValue;
}

interface UsageRepositoryShape {
  checkInDevice(
    deviceId: string,
    device: UsageDevice,
    service: UsageServiceCheckIn,
    checkedInAt: Date,
  ): Effect.Effect<void, DatabaseError, any>;
  /** One db.batch of single-row upserts (D1 binds ~100 params/statement). */
  upsertChunk(
    userId: string,
    deviceId: string,
    rows: readonly UsageDayInput[],
    syncedAt: Date,
  ): Effect.Effect<void, DatabaseError, any>;
  touchDevice(
    deviceId: string,
    device: UsageDevice,
    syncedAt: Date,
  ): Effect.Effect<void, DatabaseError, any>;
  upsertSourceStats(
    userId: string,
    deviceId: string,
    stats: readonly SourceUsageStatsInput[],
    syncedAt: Date,
  ): Effect.Effect<void, DatabaseError, any>;
  upsertRawReports(
    userId: string,
    deviceId: string,
    reports: readonly StoredRawUsageReport[],
    capturedAt: Date,
  ): Effect.Effect<void, DatabaseError | RawUsageStorageError, any>;
  insertEvents(
    userId: string,
    deviceId: string,
    events: readonly UsageEventInput[],
    syncedAt: Date,
  ): Effect.Effect<{ stored: number }, DatabaseError, any>;
  insertSessions(
    userId: string,
    deviceId: string,
    sessions: readonly UsageSessionInput[],
    syncedAt: Date,
  ): Effect.Effect<{ stored: number }, DatabaseError, any>;
  upsertGithubDays(
    userId: string,
    deviceId: string,
    days: readonly UsageGithubDayInput[],
    syncedAt: Date,
  ): Effect.Effect<{ upserted: number }, DatabaseError, any>;
  getPresenceDevices(userId: string): Effect.Effect<PresenceDeviceSummary[], DatabaseError, any>;
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
    checkIn: Effect.fn("UsageService.checkIn")(function* (identity, device, service) {
      const deviceId = yield* requireDeviceId(identity);
      const checkedInAt = new Date();
      yield* repository.checkInDevice(deviceId, device, service, checkedInAt).pipe(Effect.orDie);

      return {
        checkedInAt: checkedInAt.toISOString(),
      };
    }),
    ingestRaw: Effect.fn("UsageService.ingestRaw")(function* (
      identity,
      device,
      reports,
      sourceStats = [],
    ) {
      const deviceId = yield* requireDeviceId(identity);
      const syncedAt = new Date();
      const parsed = yield* parseRawUsageReports(reports);
      const rawReports = yield* prepareRawReports(
        identity.user.id,
        deviceId,
        parsed.persistableReports,
        syncedAt,
      );

      yield* repository
        .upsertRawReports(identity.user.id, deviceId, rawReports, syncedAt)
        .pipe(Effect.orDie);

      const upserted = yield* writeStructuredUsage(
        repository,
        identity.user.id,
        deviceId,
        device,
        parsed.rows,
        mergeSourceStats(parsed.sourceStats, sourceStats),
        syncedAt,
      );

      return {
        received: reports.length,
        syncedAt: syncedAt.toISOString(),
        upserted,
      };
    }),
    syncBatch: Effect.fn("UsageService.syncBatch")(function* (
      identity,
      device,
      days,
      sourceStats = [],
    ) {
      const deviceId = yield* requireDeviceId(identity);
      const syncedAt = new Date();

      const upserted = yield* writeStructuredUsage(
        repository,
        identity.user.id,
        deviceId,
        device,
        days,
        sourceStats,
        syncedAt,
      );

      return {
        received: days.length,
        syncedAt: syncedAt.toISOString(),
        upserted,
      };
    }),
    ingestEvents: Effect.fn("UsageService.ingestEvents")(function* (identity, device, events) {
      const deviceId = yield* requireDeviceId(identity);
      const syncedAt = new Date();

      const { stored } = yield* repository
        .insertEvents(identity.user.id, deviceId, events, syncedAt)
        .pipe(Effect.orDie);

      yield* repository.touchDevice(deviceId, device, syncedAt).pipe(Effect.orDie);

      return {
        received: events.length,
        stored,
        syncedAt: syncedAt.toISOString(),
      };
    }),
    ingestSessions: Effect.fn("UsageService.ingestSessions")(
      function* (identity, device, sessions) {
        const deviceId = yield* requireDeviceId(identity);
        const syncedAt = new Date();

        const { stored } = yield* repository
          .insertSessions(identity.user.id, deviceId, sessions, syncedAt)
          .pipe(Effect.orDie);

        yield* repository.touchDevice(deviceId, device, syncedAt).pipe(Effect.orDie);

        return {
          received: sessions.length,
          stored,
          syncedAt: syncedAt.toISOString(),
        };
      },
    ),
    ingestGithub: Effect.fn("UsageService.ingestGithub")(function* (identity, device, days) {
      const deviceId = yield* requireDeviceId(identity);
      const syncedAt = new Date();

      const { upserted } = yield* repository
        .upsertGithubDays(identity.user.id, deviceId, days, syncedAt)
        .pipe(Effect.orDie);

      yield* repository.touchDevice(deviceId, device, syncedAt).pipe(Effect.orDie);

      return {
        received: days.length,
        upserted,
        syncedAt: syncedAt.toISOString(),
      };
    }),
    getPresence: Effect.fn("UsageService.getPresence")(function* (userId) {
      const devices = yield* repository.getPresenceDevices(userId);
      return { devices };
    }),
  });
});

function requireDeviceId(identity: typeof CliIdentity.Type): Effect.Effect<string, DeviceMissing> {
  const deviceId = identity.deviceId;
  if (deviceId !== null) {
    return Effect.succeed(deviceId);
  }

  return Effect.fail(
    new DeviceMissing({
      message: "This token has no device; run `tokenmaxxing login` to mint a new one.",
    }),
  );
}

function prepareRawReports(
  userId: string,
  deviceId: string,
  reports: readonly PersistableDailyReport[],
  processedAt: Date,
): Effect.Effect<StoredRawUsageReport[]> {
  return Effect.forEach(reports, (report) =>
    Effect.gen(function* () {
      const payloadJson = JSON.stringify(report.payload) ?? "null";
      const ccusageCommand = report.command.join(" ");
      const payloadHash = yield* sha256Hex(
        `${report.source}\n${report.reportKind}\n${ccusageCommand}\n${payloadJson}`,
      );

      return {
        ccusageCommand,
        id: `${deviceId}:${payloadHash}`,
        objectKey: rawReportObjectKey({
          deviceId,
          payloadHash,
          reportKind: report.reportKind,
          source: report.source,
          userId,
        }),
        parserVersion: PARSER_VERSION,
        payloadBytes: textEncoder.encode(payloadJson).byteLength,
        payloadHash,
        payloadJson,
        processedAt,
        reportKind: report.reportKind,
        source: report.source,
      };
    }),
  );
}

function rawReportObjectKey(input: {
  deviceId: string;
  payloadHash: string;
  reportKind: "daily";
  source: string;
  userId: string;
}): string {
  return [
    "users",
    encodeKeyPart(input.userId),
    "devices",
    encodeKeyPart(input.deviceId),
    "ccusage",
    encodeKeyPart(input.source),
    input.reportKind,
    `${input.payloadHash}.json`,
  ].join("/");
}

function encodeKeyPart(value: string): string {
  return encodeURIComponent(value);
}

function mergeSourceStats(
  legacyStats: readonly SourceUsageStatsInput[],
  explicitStats: readonly SourceUsageStatsInput[],
): SourceUsageStatsInput[] {
  const merged = new Map<string, SourceUsageStatsInput>();
  for (const stat of legacyStats) {
    merged.set(stat.source, stat);
  }
  for (const stat of explicitStats) {
    merged.set(stat.source, stat);
  }

  return [...merged.values()];
}

function writeStructuredUsage(
  repository: UsageRepositoryShape,
  userId: string,
  deviceId: string,
  device: UsageDevice,
  days: readonly UsageDayInput[],
  sourceStats: readonly SourceUsageStatsInput[],
  syncedAt: Date,
) {
  return Effect.gen(function* () {
    const normalizedDays = normalizeUsageDays(days);
    for (let offset = 0; offset < normalizedDays.length; offset += UPSERT_CHUNK_SIZE) {
      yield* repository
        .upsertChunk(
          userId,
          deviceId,
          normalizedDays.slice(offset, offset + UPSERT_CHUNK_SIZE),
          syncedAt,
        )
        .pipe(Effect.orDie);
    }
    yield* repository.upsertSourceStats(userId, deviceId, sourceStats, syncedAt).pipe(Effect.orDie);
    yield* repository.touchDevice(deviceId, device, syncedAt).pipe(Effect.orDie);

    return normalizedDays.length;
  });
}

const textEncoder = new TextEncoder();

export { makeUsageService, UsageRepository, UsageService };

export type { StoredRawUsageReport, SyncResult, UsageRepositoryShape, UsageServiceCheckIn };
