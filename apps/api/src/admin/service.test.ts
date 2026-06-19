import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { Forbidden, type AdminUsersResponse } from "@tokenmaxxing/api-contract";

import {
  AdminRepository,
  adminDeviceStatus,
  makeAdminService,
  type AdminDeviceSnapshot,
  type AdminRepositoryShape,
  type AdminUserSnapshot,
} from "./service";

const now = new Date("2026-06-19T20:00:00.000Z");

interface TestAdminService {
  listUsers(userId: string): Effect.Effect<typeof AdminUsersResponse.Type, Forbidden>;
}

function device(input: Partial<AdminDeviceSnapshot> = {}): AdminDeviceSnapshot {
  return {
    arch: "arm64",
    createdAt: "2026-06-19T18:00:00.000Z",
    id: "device_123",
    lastSyncAt: "2026-06-19T19:30:00.000Z",
    name: "Mac.localdomain",
    platform: "darwin",
    version: "0.5.4",
    ...input,
  };
}

function snapshot(input: Partial<AdminUserSnapshot> = {}): AdminUserSnapshot {
  return {
    accounts: [
      {
        email: "alexandru@851.sh",
        emailVerified: true,
        login: "alex",
        provider: "google",
      },
    ],
    devices: [device()],
    sources: ["codex"],
    tokens: [
      { lastUsedAt: "2026-06-19T19:31:00.000Z", revokedAt: null },
      { lastUsedAt: null, revokedAt: "2026-06-18T00:00:00.000Z" },
    ],
    usage: {
      activeDays: 12,
      lastUsageDate: "2026-06-19",
      totalSpendUsd: 34.56,
      totalTokens: 123_456,
    },
    user: {
      avatarUrl: null,
      createdAt: "2026-06-18T00:00:00.000Z",
      id: "user_123",
      login: "pondorasti",
      name: "Alexandru",
      updatedAt: "2026-06-19T00:00:00.000Z",
    },
    ...input,
  };
}

function makeRepository(options: {
  allowedEmails?: readonly string[] | undefined;
  snapshots?: AdminUserSnapshot[] | undefined;
}): AdminRepositoryShape {
  const allowedEmails = new Set(options.allowedEmails ?? []);

  return {
    hasVerifiedEmail: (_userId, email) => Effect.succeed(allowedEmails.has(email)),
    listUserSnapshots: () => Effect.succeed(options.snapshots ?? [snapshot()]),
  };
}

async function makeService(repository: AdminRepositoryShape) {
  return (await Effect.runPromise(
    makeAdminService({
      fetchLatestCliVersion: () => Effect.succeed("0.5.4"),
      now: () => now,
    }).pipe(Effect.provideService(AdminRepository, repository)),
  )) as unknown as TestAdminService;
}

describe("AdminService.listUsers", () => {
  it("rejects signed-in users without the admin verified email", async () => {
    const service = await makeService(makeRepository({}));

    await expect(Effect.runPromise(service.listUsers("user_123"))).rejects.toBeInstanceOf(
      Forbidden,
    );
  });

  it("returns debug rows and summary counts for the admin user", async () => {
    const service = await makeService(makeRepository({ allowedEmails: ["alexandru@851.sh"] }));

    const response = await Effect.runPromise(service.listUsers("user_123"));

    expect(response.summary).toEqual({
      latest: 1,
      outdated: 0,
      stale: 0,
      totalDevices: 1,
      totalUsers: 1,
      unknown: 0,
    });
    expect(response.users[0]).toMatchObject({
      activeTokenCount: 1,
      deviceCount: 1,
      latestCheckInAt: "2026-06-19T19:30:00.000Z",
      revokedTokenCount: 1,
      status: "latest",
      verifiedEmails: ["alexandru@851.sh"],
    });
  });

  it("allows the pondorasti Gmail address as an internal admin email", async () => {
    const service = await makeService(makeRepository({ allowedEmails: ["pondorasti@gmail.com"] }));

    await expect(Effect.runPromise(service.listUsers("user_123"))).resolves.toMatchObject({
      summary: { totalUsers: 1 },
    });
  });
});

describe("adminDeviceStatus", () => {
  it("classifies latest, outdated, stale, and unknown devices", () => {
    expect(adminDeviceStatus(device(), "0.5.4", now)).toBe("latest");
    expect(adminDeviceStatus(device({ version: "0.5.3" }), "0.5.4", now)).toBe("outdated");
    expect(
      adminDeviceStatus(device({ lastSyncAt: "2026-06-19T12:00:00.000Z" }), "0.5.4", now),
    ).toBe("stale");
    expect(adminDeviceStatus(device({ arch: null, version: null }), "0.5.4", now)).toBe("unknown");
    expect(adminDeviceStatus(device({ lastSyncAt: null }), "0.5.4", now)).toBe("unknown");
  });
});
