import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import {
  Forbidden,
  type AdminDeviceStatus,
  type AdminUserDebugRow,
  type AdminUsersResponse,
  type OAuthProviderId,
} from "@tokenmaxxing/api-contract";

import type { DatabaseError } from "../database";

const ADMIN_EMAILS = ["alexandru@851.sh", "pondorasti@gmail.com"] as const;
const STALE_THRESHOLD_MS = 6 * 60 * 60 * 1000;
const NPM_LATEST_URL = "https://registry.npmjs.org/@851-labs%2Ftokenmaxxing/latest";
const LATEST_VERSION_CACHE_MS = 5 * 60 * 1000;

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
  lastSyncAt: string | null;
  name: string;
  platform: string;
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
  fetchLatestCliVersion?: (() => Effect.Effect<string | null>) | undefined;
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
    const fetchLatestCliVersion = options.fetchLatestCliVersion ?? defaultFetchLatestCliVersion;

    return AdminService.of({
      listUsers: Effect.fn("AdminService.listUsers")(function* (userId) {
        const allowed = yield* isInternalAdmin(repository, userId);
        if (!allowed) {
          return yield* Effect.fail(new Forbidden({ message: "Not found." }));
        }

        const generatedAt = now();
        const [latestCliVersion, snapshots] = yield* Effect.all([
          fetchLatestCliVersion(),
          repository.listUserSnapshots().pipe(Effect.orDie),
        ]);
        const users = snapshots.map((snapshot) =>
          adminUserDebugRow(snapshot, latestCliVersion, generatedAt),
        );

        return {
          generatedAt: generatedAt.toISOString(),
          latestCliVersion,
          staleThresholdHours: STALE_THRESHOLD_MS / (60 * 60 * 1000),
          summary: adminSummary(users),
          users,
        };
      }),
    });
  });
}

const AdminServiceLive = Layer.effect(AdminService, makeAdminService());

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
  latestCliVersion: string | null,
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
    latestCheckInAt: latestDevice?.lastSyncAt ?? null,
    latestDevice,
    providers,
    revokedTokenCount,
    sources: snapshot.sources,
    status: adminDeviceStatus(latestDevice, latestCliVersion, now),
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
  latestCliVersion: string | null,
  now: Date,
): AdminDeviceStatus {
  if (device === null || device.lastSyncAt === null) {
    return "unknown";
  }

  if (device.arch === null && device.version === null) {
    return "unknown";
  }

  const lastSync = Date.parse(device.lastSyncAt);
  if (!Number.isFinite(lastSync)) {
    return "unknown";
  }

  if (now.getTime() - lastSync > STALE_THRESHOLD_MS) {
    return "stale";
  }

  if (
    latestCliVersion !== null &&
    device.version !== null &&
    normalizeVersion(device.version) !== normalizeVersion(latestCliVersion)
  ) {
    return "outdated";
  }

  return "latest";
}

function adminSummary(users: readonly (typeof AdminUserDebugRow.Type)[]) {
  return users.reduce(
    (summary, user) => ({
      ...summary,
      [user.status]: summary[user.status] + 1,
      totalDevices: summary.totalDevices + user.deviceCount,
      totalUsers: summary.totalUsers + 1,
    }),
    {
      latest: 0,
      outdated: 0,
      stale: 0,
      totalDevices: 0,
      totalUsers: 0,
      unknown: 0,
    },
  );
}

function latestDeviceFor(devices: readonly AdminDeviceSnapshot[]): AdminDeviceSnapshot | null {
  return [...devices].sort(compareDevicesByFreshness)[0] ?? null;
}

function compareDevicesByFreshness(left: AdminDeviceSnapshot, right: AdminDeviceSnapshot): number {
  const leftSync = isoTime(left.lastSyncAt);
  const rightSync = isoTime(right.lastSyncAt);
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

function normalizeVersion(version: string): string {
  return version.trim().replace(/^v/i, "");
}

let latestVersionCache: { expiresAt: number; value: string | null } | null = null;

function defaultFetchLatestCliVersion(): Effect.Effect<string | null> {
  const now = Date.now();
  if (latestVersionCache !== null && latestVersionCache.expiresAt > now) {
    return Effect.succeed(latestVersionCache.value);
  }

  return Effect.tryPromise({
    try: async () => {
      const response = await fetch(NPM_LATEST_URL, {
        headers: { accept: "application/json" },
      });
      if (!response.ok) {
        return null;
      }

      const body = (await response.json()) as unknown;
      return latestVersionFromRegistryBody(body);
    },
    catch: (cause) => cause,
  }).pipe(
    Effect.catch(() => Effect.succeed(null)),
    Effect.map((value: string | null) => {
      latestVersionCache = {
        expiresAt: now + LATEST_VERSION_CACHE_MS,
        value,
      };
      return value;
    }),
  );
}

function latestVersionFromRegistryBody(body: unknown): string | null {
  if (body === null || typeof body !== "object" || !("version" in body)) {
    return null;
  }

  const version = (body as { version?: unknown }).version;
  return typeof version === "string" && version.length > 0 ? version : null;
}

export {
  ADMIN_EMAILS,
  AdminRepository,
  AdminService,
  AdminServiceLive,
  adminDeviceStatus,
  adminSummary,
  adminUserDebugRow,
  isInternalAdmin,
  latestVersionFromRegistryBody,
  makeAdminService,
};

export type {
  AdminAccountSnapshot,
  AdminDeviceSnapshot,
  AdminRepositoryShape,
  AdminServiceOptions,
  AdminServiceShape,
  AdminTokenSnapshot,
  AdminUsageSnapshot,
  AdminUserSnapshot,
};
