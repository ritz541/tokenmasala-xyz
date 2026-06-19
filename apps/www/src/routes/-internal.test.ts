import { QueryClient } from "@tanstack/react-query";
import { isRedirect, type AnyRedirect } from "@tanstack/react-router";
import type { AdminUsersResponse } from "@tokenmaxxing/api-contract";
import { describe, expect, it, vi } from "vitest";

import { adminUsersQueryOptions } from "../lib/queries";
import {
  fetchInternalAdminData,
  fleetSummary,
  formatRelativeTime,
  loadInternalRoute,
} from "./internal";

const adminData: typeof AdminUsersResponse.Type = {
  generatedAt: "2026-06-19T20:00:00.000Z",
  latestCliVersion: "0.5.4",
  staleThresholdHours: 6,
  summary: {
    latest: 1,
    outdated: 0,
    stale: 0,
    totalDevices: 1,
    totalUsers: 1,
    unknown: 0,
  },
  users: [
    {
      accounts: [
        {
          email: "alexandru@851.sh",
          emailVerified: true,
          login: "alex",
          provider: "google",
        },
      ],
      activeDays: 12,
      activeTokenCount: 1,
      createdAt: "2026-06-18T00:00:00.000Z",
      deviceCount: 1,
      lastTokenUsedAt: "2026-06-19T19:31:00.000Z",
      lastUsageDate: "2026-06-19",
      latestCheckInAt: "2026-06-19T19:30:00.000Z",
      latestDevice: {
        arch: "arm64",
        createdAt: "2026-06-19T18:00:00.000Z",
        id: "device_123",
        lastSyncAt: "2026-06-19T19:30:00.000Z",
        name: "Mac.localdomain",
        platform: "darwin",
        version: "0.5.4",
      },
      providers: ["google"],
      revokedTokenCount: 0,
      sources: ["codex"],
      status: "latest",
      tokenCount: 1,
      totalSpendUsd: 34.56,
      totalTokens: 123_456,
      updatedAt: "2026-06-19T00:00:00.000Z",
      user: {
        avatarUrl: null,
        id: "user_123",
        login: "pondorasti",
        name: "Alexandru",
      },
      verifiedEmails: ["alexandru@851.sh"],
    },
  ],
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    status,
  });
}

describe("fetchInternalAdminData", () => {
  it("returns unauthenticated for a missing session and forwards cookies", async () => {
    const fetcher = vi.fn(async () => jsonResponse(401, { message: "Sign in required." }));

    await expect(fetchInternalAdminData("tmx_session=abc", fetcher)).resolves.toEqual({
      status: "unauthenticated",
    });
    expect(fetcher).toHaveBeenCalledWith(expect.stringMatching(/\/admin\/users$/), {
      headers: { cookie: "tmx_session=abc" },
    });
  });

  it("returns forbidden for non-admin sessions", async () => {
    const fetcher = vi.fn(async () => jsonResponse(403, { message: "Not found." }));

    await expect(fetchInternalAdminData(undefined, fetcher)).resolves.toEqual({
      status: "forbidden",
    });
  });

  it("decodes admin rows from the API", async () => {
    const fetcher = vi.fn(async () => jsonResponse(200, adminData));

    await expect(fetchInternalAdminData(undefined, fetcher)).resolves.toEqual({
      data: adminData,
      status: "ok",
    });
  });
});

describe("loadInternalRoute", () => {
  it("redirects unauthenticated users to login with an internal redirect", async () => {
    const queryClient = new QueryClient();

    await expect(
      loadInternalRoute(queryClient, async () => ({ status: "unauthenticated" })),
    ).rejects.toSatisfy((error: unknown) => {
      expect(isRedirect(error)).toBe(true);

      const redirect = error as AnyRedirect;
      expect(redirect.options.to).toBe("/login");
      expect(redirect.options.search).toEqual({ redirect: "/internal" });

      return true;
    });
  });

  it("seeds the admin query cache for authorized users", async () => {
    const queryClient = new QueryClient();

    await expect(
      loadInternalRoute(queryClient, async () => ({ data: adminData, status: "ok" })),
    ).resolves.toEqual({ data: adminData, status: "ok" });
    expect(queryClient.getQueryData(adminUsersQueryOptions.queryKey)).toEqual(adminData);
  });
});

describe("internal formatting helpers", () => {
  it("formats summary and relative timestamps", () => {
    expect(fleetSummary(adminData)).toBe(
      "User fleet · 1 on latest · 0 outdated · 0 stale · 0 unknown",
    );
    expect(formatRelativeTime("2026-06-19T19:30:00.000Z", adminData.generatedAt)).toBe("30m ago");
  });
});
