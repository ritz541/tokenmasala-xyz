import * as Context from "effect/Context";
import * as Effect from "effect/Effect";

import {
  Forbidden,
  type AdminDeviceStatus,
  type AdminUserDebugRow,
  type AdminUsersResponse,
  type OAuthProviderId,
  type ServiceCheckInStatusValue,
} from "@tokenmaxxing/api-contract";

import type { DatabaseError } from "../database";

const ADMIN_EMAILS = ["alexandru@851.sh", "pondorasti@gmail.com"] as const;
const STALE_THRESHOLD_MS = 6 * 60 * 60 * 1000;
const ROLLOUT_GRACE_MS = 2 * 60 * 60 * 1000;
const NPM_PACKAGE_URL = "https://registry.npmjs.org/@851-labs%2Ftokenmaxxing";
const LATEST_VERSION_CACHE_MS = 5 * 60 * 1000;

interface LatestCliRelease {
  publishedAt: string | null;
  version: string | null;
}

interface AdminAccountSnapshot {
  email: string | null;
  emailVerified: boolean;
  login: string | null;
  provider: OAuthProviderId;
}

interface AdminDeviceSnapshot {
  arch: string | null;
  createdAt: string;
  id: string;
  lastCheckInAt: string | null;
  lastSyncAt: string | null;
  name: string;
  platform: string;
  serviceBackend: string | null;
  serviceError: string | null;
  serviceReloadRequired: boolean | null;
  serviceSchedulerActive: boolean | null;
  serviceStatus: ServiceCheckInStatusValue | null;
  serviceTemplateVersion: number | null;
  version: string | null;
}

interface AdminTokenSnapshot {
  lastUsedAt: string | null;
  revokedAt: string | null;
}

interface AdminUsageSnapshot {
  activeDays: number;
  lastUsageDate: string | null;
  totalSpendUsd: number;
  totalTokens: number;
}

interface AdminUserSnapshot {
  accounts: AdminAccountSnapshot[];
  devices: AdminDeviceSnapshot[];
  sources: string[];
  tokens: AdminTokenSnapshot[];
  usage: AdminUsageSnapshot;
  user: {
    avatarUrl: string | null;
    createdAt: string;
    id: string;
    login: string;
    name: string | null;
    updatedAt: string;
  };
}

interface AdminServiceShape {
  listUsers(userId: string): Effect.Effect<typeof AdminUsersResponse.Type, Forbidden, any>;
}

interface AdminRepositoryShape {
  hasVerifiedEmail(userId: string, email: string): Effect.Effect<boolean, DatabaseError, any>;
  listUserSnapshots(): Effect.Effect<AdminUserSnapshot[], DatabaseError, any>;
}

interface AdminServiceOptions {
  fetchLatestCliRelease?: (() => Effect.Effect<LatestCliRelease>) | undefined;
  now?: (() => Date) | undefined;
}

class AdminService extends Context.Service<AdminService, AdminServiceShape>()(
  "@tokenmaxxing/api/AdminService",
) {}

class AdminRepository extends Context.Service<AdminRepository, AdminRepositoryShape>()(
  "@tokenmaxxing/api/AdminRepository",
) {}

function makeAdminService(options: AdminServiceOptions = {}) {
  return Effect.gen(function* () {
    const repository = yield* AdminRepository;
    const now = options.now ?? (() => new Date());
    const fetchLatestCliRelease = options.fetchLatestCliRelease ?? defaultFetchLatestCliRelease;

    return AdminService.of({
      listUsers: Effect.fn("AdminService.listUsers")(function* (userId) {
        const allowed = yield* isInternalAdmin(repository, userId);
        if (!allowed) {
          return yield* Effect.fail(new Forbidden({ message: "Not found." }));
        }

        const generatedAt = now();
        const [latestCliRelease, snapshots] = yield* Effect.all([
          fetchLatestCliRelease(),
          repository.listUserSnapshots().pipe(Effect.orDie),
        ]);
        const users = snapshots.map((snapshot) =>
          adminUserDebugRow(snapshot, latestCliRelease, generatedAt),
        );

        return {
          generatedAt: generatedAt.toISOString(),
          latestCliPublishedAt: latestCliRelease.publishedAt,
          latestCliVersion: latestCliRelease.version,
          rolloutGraceHours: ROLLOUT_GRACE_MS / (60 * 60 * 1000),
          staleThresholdHours: STALE_THRESHOLD_MS / (60 * 60 * 1000),
          summary: adminSummary(users),
          users,
        };
      }),
    });
  });
}

function isInternalAdmin(
  repository: AdminRepositoryShape,
  userId: string,
): Effect.Effect<boolean, never, any> {
  return Effect.gen(function* () {
    for (const email of ADMIN_EMAILS) {
      const allowed = yield* repository.hasVerifiedEmail(userId, email).pipe(Effect.orDie);
      if (allowed) {
        return true;
      }
    }

    return false;
  });
}

function adminUserDebugRow(
  snapshot: AdminUserSnapshot,
  latestCliRelease: LatestCliRelease,
  now: Date,
): typeof AdminUserDebugRow.Type {
  const latestDevice = latestDeviceFor(snapshot.devices);
  const activeTokenCount = snapshot.tokens.filter((token) => token.revokedAt === null).length;
  const revokedTokenCount = snapshot.tokens.length - activeTokenCount;
  const lastTokenUsedAt = maxIso(snapshot.tokens.map((token) => token.lastUsedAt));
  const verifiedEmails = [
    ...new Set(
      snapshot.accounts.flatMap((account) =>
        account.emailVerified && account.email !== null ? [account.email] : [],
      ),
    ),
  ].sort();
  const providers = [...new Set(snapshot.accounts.map((account) => account.provider))].sort();

  return {
    accounts: snapshot.accounts,
    activeDays: snapshot.usage.activeDays,
    activeTokenCount,
    createdAt: snapshot.user.createdAt,
    deviceCount: snapshot.devices.length,
    lastTokenUsedAt,
    lastUsageDate: snapshot.usage.lastUsageDate,
    latestCheckInAt: latestDevice === null ? null : latestDeviceCheckIn(latestDevice),
    latestDevice,
    providers,
    revokedTokenCount,
    sources: snapshot.sources,
    status: adminDeviceStatus(latestDevice, latestCliRelease, now),
    tokenCount: snapshot.tokens.length,
    totalSpendUsd: snapshot.usage.totalSpendUsd,
    totalTokens: snapshot.usage.totalTokens,
    updatedAt: snapshot.user.updatedAt,
    user: {
      avatarUrl: snapshot.user.avatarUrl,
      id: snapshot.user.id,
      login: snapshot.user.login,
      name: snapshot.user.name,
    },
    verifiedEmails,
  };
}

function adminDeviceStatus(
  device: AdminDeviceSnapshot | null,
  latestCliRelease: LatestCliRelease,
  now: Date,
): AdminDeviceStatus {
  if (device === null || device.lastSyncAt === null) {
    if (device !== null && deviceNeedsRepair(device)) {
      return "repair-needed";
    }
  }

  if (device === null) {
    return "unknown";
  }

  if (deviceNeedsRepair(device)) {
    return "repair-needed";
  }

  if (device.arch === null && device.version === null) {
    return "unknown";
  }

  const lastSeenAt = latestDeviceCheckIn(device);
  if (lastSeenAt === null) {
    return "unknown";
  }

  const lastSeen = Date.parse(lastSeenAt);
  if (!Number.isFinite(lastSeen)) {
    return "unknown";
  }

  const elapsedMs = now.getTime() - lastSeen;
  if (elapsedMs > STALE_THRESHOLD_MS) {
    return "stale";
  }

  if (
    latestCliRelease.version !== null &&
    device.version !== null &&
    normalizeVersion(device.version) !== normalizeVersion(latestCliRelease.version)
  ) {
    const publishedAt =
      latestCliRelease.publishedAt === null ? Number.NaN : Date.parse(latestCliRelease.publishedAt);
    if (!Number.isFinite(publishedAt)) {
      return elapsedMs <= ROLLOUT_GRACE_MS ? "updating" : "stale";
    }

    return now.getTime() - publishedAt <= ROLLOUT_GRACE_MS ? "updating" : "stale";
  }

  return "latest";
}

function adminSummary(users: readonly (typeof AdminUserDebugRow.Type)[]) {
  return users.reduce(
    (summary, user) => {
      switch (user.status) {
        case "latest":
          summary.latest += 1;
          break;
        case "repair-needed":
          summary.repairNeeded += 1;
          break;
        case "stale":
          summary.stale += 1;
          break;
        case "unknown":
          summary.unknown += 1;
          break;
        case "updating":
          summary.updating += 1;
          break;
      }
      summary.totalDevices += user.deviceCount;
      summary.totalUsers += 1;

      return summary;
    },
    {
      latest: 0,
      repairNeeded: 0,
      stale: 0,
      totalDevices: 0,
      totalUsers: 0,
      updating: 0,
      unknown: 0,
    },
  );
}

function latestDeviceFor(devices: readonly AdminDeviceSnapshot[]): AdminDeviceSnapshot | null {
  return [...devices].sort(compareDevicesByFreshness)[0] ?? null;
}

function compareDevicesByFreshness(left: AdminDeviceSnapshot, right: AdminDeviceSnapshot): number {
  const leftSync = isoTime(latestDeviceCheckIn(left));
  const rightSync = isoTime(latestDeviceCheckIn(right));
  if (leftSync !== rightSync) {
    return rightSync - leftSync;
  }

  return isoTime(right.createdAt) - isoTime(left.createdAt);
}

function maxIso(values: readonly (string | null)[]): string | null {
  const sorted = values.filter((value): value is string => value !== null).sort();
  return sorted.at(-1) ?? null;
}

function isoTime(value: string | null): number {
  if (value === null) {
    return 0;
  }

  const time = Date.parse(value);
  return Number.isFinite(time) ? time : 0;
}

function latestDeviceCheckIn(device: AdminDeviceSnapshot): string | null {
  return device.lastCheckInAt ?? device.lastSyncAt;
}

function deviceNeedsRepair(device: AdminDeviceSnapshot): boolean {
  return (
    device.serviceReloadRequired === true ||
    device.serviceSchedulerActive === false ||
    device.serviceStatus === "failure"
  );
}

function normalizeVersion(version: string): string {
  return version.trim().replace(/^v/i, "");
}

let latestReleaseCache: { expiresAt: number; value: LatestCliRelease } | null = null;

function defaultFetchLatestCliRelease(): Effect.Effect<LatestCliRelease> {
  const now = Date.now();
  if (latestReleaseCache !== null && latestReleaseCache.expiresAt > now) {
    return Effect.succeed(latestReleaseCache.value);
  }

  return Effect.tryPromise({
    try: async () => {
      const response = await fetch(NPM_PACKAGE_URL, {
        headers: { accept: "application/json" },
      });
      if (!response.ok) {
        return noLatestCliRelease();
      }

      const body = (await response.json()) as unknown;
      return latestReleaseFromRegistryBody(body);
    },
    catch: (cause) => cause,
  }).pipe(
    Effect.catch(() => Effect.succeed(noLatestCliRelease())),
    Effect.map((value) => {
      latestReleaseCache = {
        expiresAt: now + LATEST_VERSION_CACHE_MS,
        value,
      };
      return value;
    }),
  );
}

function noLatestCliRelease(): LatestCliRelease {
  return { publishedAt: null, version: null };
}

function latestReleaseFromRegistryBody(body: unknown): LatestCliRelease {
  if (body === null || typeof body !== "object") {
    return noLatestCliRelease();
  }

  const directVersion = (body as { version?: unknown }).version;
  const distTags = (body as { "dist-tags"?: unknown })["dist-tags"];
  const taggedVersion =
    distTags !== null && typeof distTags === "object"
      ? (distTags as { latest?: unknown }).latest
      : undefined;
  const version =
    typeof taggedVersion === "string" && taggedVersion.length > 0
      ? taggedVersion
      : typeof directVersion === "string" && directVersion.length > 0
        ? directVersion
        : null;
  if (version === null) {
    return noLatestCliRelease();
  }

  const times = (body as { time?: unknown }).time;
  const publishedAt =
    times !== null && typeof times === "object"
      ? (times as Record<string, unknown>)[version]
      : undefined;

  return {
    publishedAt: typeof publishedAt === "string" && publishedAt.length > 0 ? publishedAt : null,
    version,
  };
}

export {
  AdminRepository,
  AdminService,
  adminDeviceStatus,
  latestReleaseFromRegistryBody,
  makeAdminService,
};

export type { AdminDeviceSnapshot, AdminRepositoryShape, AdminUserSnapshot, LatestCliRelease };
