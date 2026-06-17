import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";

import { ConsoleService } from "../services";
import type { CommandInstall, ServiceMetadata } from "./service";
import { formatServiceRefreshResult, refreshInstalledService, updateProgram } from "./update";

const install: CommandInstall = {
  autoUpdateManager: "npm",
  commandPath: "/usr/local/bin/tokenmaxxing",
  resolvedCommandPath: "/usr/local/lib/node_modules/@851-labs/tokenmaxxing/dist/index.js",
};

function testConsole() {
  const logs: string[] = [];
  const layer = Layer.succeed(ConsoleService)({
    error: (message?: unknown) => {
      logs.push(String(message));
    },
    log: (message?: unknown) => {
      logs.push(String(message));
    },
  });

  return { layer, logs };
}

describe("updateProgram", () => {
  it("updates through the detected package manager and skips service refresh when absent", async () => {
    const { layer, logs } = testConsole();
    const managers: string[] = [];

    const exit = await Effect.runPromiseExit(
      updateProgram({
        findCommandInstall: () => Effect.succeed(install),
        isServiceInstalled: () => Effect.succeed(false),
        runPackageManagerUpdate: (manager) =>
          Effect.sync(() => {
            managers.push(manager);
          }),
      }).pipe(Effect.provide(layer)),
    );

    expect(exit._tag).toBe("Success");
    expect(managers).toEqual(["npm"]);
    expect(logs).toEqual([
      "Detected package manager: npm",
      "Running: npm install -g @851-labs/tokenmaxxing@latest --silent",
      "Updated tokenmaxxing.",
      "Service: not installed.",
    ]);
  });

  it("refreshes an installed service after updating", async () => {
    const { layer, logs } = testConsole();
    const refreshes: Array<{ autoUpdate: boolean; commandPath: string }> = [];

    const exit = await Effect.runPromiseExit(
      updateProgram({
        findCommandInstall: () => Effect.succeed(install),
        isServiceInstalled: () => Effect.succeed(true),
        readServiceMetadata: () =>
          Effect.succeed({
            autoUpdate: false,
            backend: "launchd",
            commandPath: "/usr/local/bin/tokenmaxxing",
            installedAt: "2026-06-17T00:00:00.000Z",
            schedule: "checks hourly and syncs once per local day",
            version: 1,
          } satisfies ServiceMetadata),
        refreshService: (options) =>
          Effect.sync(() => {
            refreshes.push(options);
          }),
        runPackageManagerUpdate: () => Effect.void,
      }).pipe(Effect.provide(layer)),
    );

    expect(exit._tag).toBe("Success");
    expect(refreshes).toEqual([{ autoUpdate: false, commandPath: "/usr/local/bin/tokenmaxxing" }]);
    expect(logs).toContain("Service: refreshed.");
  });

  it("keeps update successful when service refresh fails", async () => {
    const { layer, logs } = testConsole();

    const exit = await Effect.runPromiseExit(
      updateProgram({
        findCommandInstall: () => Effect.succeed(install),
        isServiceInstalled: () => Effect.succeed(true),
        refreshService: () => Effect.fail(new Error("refresh failed")),
        runPackageManagerUpdate: () => Effect.void,
      }).pipe(Effect.provide(layer)),
    );

    expect(exit._tag).toBe("Success");
    expect(logs).toContain("Service: refresh failed; run tokenmaxxing service install if needed.");
  });

  it("rejects ephemeral package-runner installs", async () => {
    const { layer } = testConsole();
    const exit = await Effect.runPromiseExit(
      updateProgram({
        findCommandInstall: () =>
          Effect.succeed({
            ...install,
            commandPath: "/home/alex/.npm/_npx/123/node_modules/.bin/tokenmaxxing",
          }),
      }).pipe(Effect.provide(layer)),
    );

    expect(exit._tag).toBe("Failure");
  });

  it("rejects unknown package managers", async () => {
    const { layer } = testConsole();
    const exit = await Effect.runPromiseExit(
      updateProgram({
        findCommandInstall: () => Effect.succeed({ ...install, autoUpdateManager: null }),
      }).pipe(Effect.provide(layer)),
    );

    expect(exit._tag).toBe("Failure");
  });
});

describe("refreshInstalledService", () => {
  it("returns not-installed when service paths are unsupported", async () => {
    const result = await Effect.runPromise(
      refreshInstalledService(install, { platform: "freebsd" }),
    );

    expect(result).toEqual({ _tag: "not-installed" });
  });

  it("formats refresh results", () => {
    expect(formatServiceRefreshResult({ _tag: "refreshed" })).toBe("Service: refreshed.");
    expect(formatServiceRefreshResult({ _tag: "not-installed" })).toBe("Service: not installed.");
    expect(formatServiceRefreshResult({ _tag: "failed", cause: "boom" })).toBe(
      "Service: refresh failed; run tokenmaxxing service install if needed.",
    );
  });
});

export {};
