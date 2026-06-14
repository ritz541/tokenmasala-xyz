import { QueryClient } from "@tanstack/react-query";
import { isRedirect, type AnyRedirect } from "@tanstack/react-router";
import { describe, expect, it, vi } from "vitest";

import { meQuery } from "../lib/queries";
import {
  confirmDeviceDelete,
  deviceDeleteConfirmationMessage,
  deviceDeleteInvalidationKeys,
  fetchSettingsSession,
  guardSettingsRoute,
} from "./settings";

const me = {
  user: {
    avatarUrl: null,
    id: "user_123",
    login: "pondorasti",
    name: null,
  },
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    status,
  });
}

describe("fetchSettingsSession", () => {
  it("returns null for an unauthenticated session", async () => {
    const fetcher = vi.fn(async () => jsonResponse(401, { message: "Sign in required." }));

    await expect(fetchSettingsSession(undefined, fetcher)).resolves.toBeNull();
    expect(fetcher).toHaveBeenCalledWith(expect.stringMatching(/\/me$/), {
      headers: undefined,
    });
  });

  it("forwards the session cookie and decodes the /me response", async () => {
    const fetcher = vi.fn(async () => jsonResponse(200, me));

    await expect(fetchSettingsSession("tmx_session=abc", fetcher)).resolves.toEqual(me);
    expect(fetcher).toHaveBeenCalledWith(expect.stringMatching(/\/me$/), {
      headers: { cookie: "tmx_session=abc" },
    });
  });
});

describe("guardSettingsRoute", () => {
  it("redirects unauthenticated users to login with a settings redirect", async () => {
    const queryClient = new QueryClient();

    await expect(guardSettingsRoute(queryClient, async () => null)).rejects.toSatisfy(
      (error: unknown) => {
        expect(isRedirect(error)).toBe(true);

        const redirect = error as AnyRedirect;
        expect(redirect.options.to).toBe("/login");
        expect(redirect.options.search).toEqual({ redirect: "/settings" });

        return true;
      },
    );
  });

  it("seeds the me query cache for authenticated users", async () => {
    const queryClient = new QueryClient();

    await guardSettingsRoute(queryClient, async () => me);

    expect(queryClient.getQueryData(meQuery.queryKey)).toEqual(me);
  });
});

describe("device deletion helpers", () => {
  it("asks for destructive confirmation with the device name", () => {
    const confirm = vi.fn(() => true);

    expect(confirmDeviceDelete({ name: "Mac.localdomain" }, confirm)).toBe(true);
    expect(confirm).toHaveBeenCalledWith(
      "Delete synced usage for Mac.localdomain? This removes the device from your profile and revokes its CLI tokens.",
    );
  });

  it("uses the expected cache invalidation keys after delete", () => {
    expect(deviceDeleteInvalidationKeys("pondorasti")).toEqual([
      ["me", "devices"],
      ["me", "tokens"],
      ["profile", "pondorasti"],
    ]);
  });

  it("keeps confirmation copy explicit about token revocation", () => {
    expect(deviceDeleteConfirmationMessage("tuftlords-MBP.localdomain")).toContain(
      "revokes its CLI tokens",
    );
  });
});
