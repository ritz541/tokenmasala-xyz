import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

import { Cause, Effect, Layer } from "effect";
import type { AuthUser } from "@tokenmaxxing/api-contract";
import { describe, expect, it } from "vitest";

import {
  ApiClientService,
  BrowserService,
  ClockService,
  type CliConfig,
  ConfigService,
  ConsoleService,
  TerminalService,
  type TokenmaxxingApiClient,
} from "../services";
import {
  autoUpdateCommandDescription,
  backendForPlatform,
  capturedServiceEnv,
  detectAutoUpdateManager,
  deterministicServiceJitterMs,
  durableTokenmaxxingCommandPath,
  findCommandOnPath,
  formatServiceLockStatus,
  formatServiceStatusAutoUpdate,
  isEphemeralCommandPath,
  isTransientCommandShimPath,
  legacyServiceWrapperPaths,
  renderLaunchdPlist,
  renderServiceWrapper,
  renderSystemdTimer,
  scheduleDescription,
  serviceScheduledSyncSince,
  serviceInstallProgram,
  serviceLockStatus,
  serviceRunFailureState,
  serviceRunLogLine,
  serviceRunSuccessState,
  type ServiceMetadata,
  type ServicePaths,
  type ServiceState,
  servicePaths,
  serviceStateJson,
  windowsTaskCreateArgs,
  windowsTaskNames,
} from "./service";
import type { SyncResult } from "./sync";

interface TestLayerOptions {
  envTokenActive?: boolean;
  initialConfig: CliConfig;
  interactive?: boolean;
  meError?: unknown;
}

interface TestState {
  browserUrls: string[];
  clearedTokens: number;
  errors: string[];
  logs: string[];
  madeClients: Array<{ baseUrl: string; token?: string | undefined }>;
  writtenTokens: string[];
}

const user: AuthUser = {
  avatarUrl: null,
  id: "user_123",
  login: "alex",
  name: null,
};

function makeTestLayer(options: TestLayerOptions) {
  let currentConfig = options.initialConfig;
  const state: TestState = {
    browserUrls: [],
    clearedTokens: 0,
    errors: [],
    logs: [],
    madeClients: [],
    writtenTokens: [],
  };

  const layer = Layer.mergeAll(
    Layer.succeed(ApiClientService)({
      make: (clientOptions) => {
        state.madeClients.push(clientOptions);

        return Effect.succeed({
          cliLogin: {
            poll: () => Effect.succeed({ status: "complete" as const, token: "tmx_new", user }),
            start: () =>
              Effect.succeed({
                code: "ABC123",
                expiresAt: "2026-06-13T20:00:00.000Z",
                intervalSeconds: 0,
                verificationUri: "https://tokenmaxxing.example/login/cli?code=ABC123",
              }),
          },
          me: {
            me: () =>
              options.meError === undefined
                ? Effect.succeed({ user })
                : Effect.fail(options.meError),
          },
          usage: {
            sync: () => Effect.succeed({ upserted: 0 }),
          },
        } as unknown as TokenmaxxingApiClient);
      },
    }),
    Layer.succeed(BrowserService)({
      open: (url) =>
        Effect.sync(() => {
          state.browserUrls.push(url);
        }),
    }),
    Layer.succeed(ClockService)({
      sleep: () => Effect.succeed(undefined),
    }),
    Layer.succeed(ConfigService)({
      clearToken: () =>
        Effect.sync(() => {
          const token = currentConfig.token;
          const { token: _token, ...nextConfig } = currentConfig;
          currentConfig = nextConfig;
          state.clearedTokens += 1;

          return {
            config: nextConfig,
            token,
            tokenCleared: token !== undefined,
          };
        }),
      ensureDeviceId: () => Effect.succeed(currentConfig.deviceId ?? "device_123"),
      hasEnvToken: () => Effect.succeed(options.envTokenActive ?? false),
      readConfig: () => Effect.succeed(currentConfig),
      writeToken: (token) =>
        Effect.sync(() => {
          currentConfig = { ...currentConfig, token };
          state.writtenTokens.push(token);

          return currentConfig;
        }),
    }),
    Layer.succeed(ConsoleService)({
      error: (message?: unknown) => {
        state.errors.push(String(message));
      },
      log: (message?: unknown) => {
        state.logs.push(String(message));
      },
    }),
    Layer.succeed(TerminalService)({
      canOpenExternalBrowser: Effect.succeed(true),
      isInteractive: Effect.succeed(options.interactive ?? true),
    }),
  );

  return { layer, state };
}

function makeInstallRuntime() {
  const installed: ServicePaths[] = [];
  const written: Array<{
    metadata: ServiceMetadata;
    paths: ServicePaths;
    wrapper: string;
  }> = [];

  return {
    installed,
    runtime: {
      env: {
        PATH: "/usr/local/bin:/usr/bin",
        TOKENMAXXING_CONFIG_DIR: "/tmp/tokenmaxxing",
      },
      findCommandInstall: () =>
        Effect.succeed({
          autoUpdateManager: "npm" as const,
          commandPath: "/usr/local/bin/tokenmaxxing",
          resolvedCommandPath: "/usr/local/lib/node_modules/@851-labs/tokenmaxxing/dist/index.js",
        }),
      home: "/Users/alex",
      installScheduler: (paths: ServicePaths) =>
        Effect.sync(() => {
          installed.push(paths);
        }),
      now: new Date("2026-06-16T12:00:00.000Z"),
      platform: "darwin" as const,
      writeFiles: (paths: ServicePaths, wrapper: string, metadata: ServiceMetadata) =>
        Effect.sync(() => {
          written.push({ metadata, paths, wrapper });
        }),
    },
    written,
  };
}

function unauthorizedError() {
  return Object.assign(new Error("unauthorized"), { _tag: "Unauthorized" as const });
}

function failureTag(exit: Awaited<ReturnType<typeof Effect.runPromiseExit>>): string | undefined {
  if (exit._tag !== "Failure") {
    return undefined;
  }

  const failure = exit.cause.reasons.find(Cause.isFailReason);

  return failure === undefined ? undefined : (failure.error as { _tag?: string })._tag;
}

describe("backendForPlatform", () => {
  it("selects the native scheduler for supported platforms", () => {
    expect(backendForPlatform("darwin")).toBe("launchd");
    expect(backendForPlatform("linux")).toBe("systemd");
    expect(backendForPlatform("win32")).toBe("windows-task-scheduler");
    expect(backendForPlatform("freebsd")).toBeNull();
  });
});

describe("servicePaths", () => {
  it("places generated files beside the stored CLI config", () => {
    const paths = servicePaths({
      env: { TOKENMAXXING_CONFIG_DIR: "/tmp/tokenmaxxing" },
      home: "/Users/alex",
      platform: "darwin",
    });

    expect(paths).toEqual({
      backend: "launchd",
      configDir: "/tmp/tokenmaxxing",
      definitionPath: "/Users/alex/Library/LaunchAgents/sh.tokenmaxxing.sync.plist",
      lockPath: "/tmp/tokenmaxxing/service.lock",
      logPath: "/tmp/tokenmaxxing/service.log",
      metadataPath: "/tmp/tokenmaxxing/service.json",
      statePath: "/tmp/tokenmaxxing/service-state.json",
      wrapperPath: "/tmp/tokenmaxxing/tokenmaxxing.sh",
    });
  });

  it("uses XDG config paths for systemd user units", () => {
    const paths = servicePaths({
      env: { TOKENMAXXING_CONFIG_DIR: "/tmp/tokenmaxxing", XDG_CONFIG_HOME: "/home/alex/.xdg" },
      home: "/home/alex",
      platform: "linux",
    });

    expect(paths?.backend).toBe("systemd");
    expect(paths?.definitionPath).toBe("/home/alex/.xdg/systemd/user/tokenmaxxing-sync.service");
  });
});

describe("renderServiceWrapper", () => {
  it("runs sync with a durable command without embedding package-manager updates", () => {
    const env = capturedServiceEnv({
      HOME: "/home/alex",
      PATH: "/usr/local/bin:/usr/bin",
      TOKENMAXXING_API_TOKEN: "tmx_secret",
      TOKENMAXXING_ENV: "development",
    });
    const wrapper = renderServiceWrapper({
      commandPath: "/usr/local/bin/tokenmaxxing",
      env,
      logPath: "/home/alex/.config/tokenmaxxing/service.log",
      platform: "linux",
    });

    expect(wrapper).toContain("'/usr/local/bin/tokenmaxxing' service run --scheduled");
    expect(wrapper).not.toContain("bun update");
    expect(wrapper).not.toContain("npm install");
    expect(wrapper).not.toContain("pnpm add");
    expect(wrapper).not.toContain("yarn global");
    expect(wrapper).not.toContain("TOKENMAXXING_API_TOKEN");
    expect(wrapper).not.toContain("tmx_secret");
  });

  it("rotates POSIX service logs before appending", () => {
    const wrapper = renderServiceWrapper({
      commandPath: "/usr/local/bin/tokenmaxxing",
      env: { HOME: "/home/alex", PATH: "/usr/local/bin:/usr/bin" },
      logPath: "/home/alex/.config/tokenmaxxing/service.log",
      platform: "linux",
    });

    expect(wrapper).toContain("rotate_tokenmaxxing_log");
    expect(wrapper).toContain('[ "$size" -lt 5242880 ] && return 0');
    expect(wrapper).toContain('rm -f "$log.3"');
    expect(wrapper).toContain('mv "$log" "$log.1"');
    expect(
      wrapper.indexOf("rotate_tokenmaxxing_log '/home/alex/.config/tokenmaxxing/service.log'"),
    ).toBeLessThan(wrapper.indexOf("} >> '/home/alex/.config/tokenmaxxing/service.log' 2>&1"));
  });

  it("renders the matching auto-update command for each package manager", () => {
    expect(autoUpdateCommandDescription("bun")).toBe(
      "bun update -g @851-labs/tokenmaxxing --latest --silent",
    );
    expect(autoUpdateCommandDescription("npm")).toBe(
      "npm install -g @851-labs/tokenmaxxing@latest --silent",
    );
    expect(autoUpdateCommandDescription("pnpm")).toBe(
      "pnpm add -g @851-labs/tokenmaxxing@latest --silent",
    );
    expect(autoUpdateCommandDescription("yarn")).toBe(
      "yarn global add @851-labs/tokenmaxxing@latest --silent",
    );
  });

  it("renders Windows wrappers without package-manager updates", () => {
    const wrapper = renderServiceWrapper({
      commandPath: "C:\\Users\\alex\\AppData\\Roaming\\npm\\tokenmaxxing.cmd",
      env: { PATH: "/usr/bin" },
      logPath: "/tmp/tokenmaxxing.log",
      platform: "win32",
    });

    expect(wrapper).not.toContain("bun update");
    expect(wrapper).not.toContain("npm install");
    expect(wrapper).not.toContain("pnpm add");
    expect(wrapper).not.toContain("yarn global");
    expect(wrapper).toContain("if %%~zA GEQ 5242880");
    expect(wrapper).toContain('"%TOKENMAXXING_LOG%.3"');
    expect(wrapper).toContain('move /y "%TOKENMAXXING_LOG%.1" "%TOKENMAXXING_LOG%.2"');
    expect(wrapper).toContain('move /y "%TOKENMAXXING_LOG%" "%TOKENMAXXING_LOG%.1"');
    expect(wrapper).toContain("service run --scheduled");
  });
});

describe("native scheduler templates", () => {
  it("renders five-minute launchd, systemd, and Windows schedules", () => {
    const paths = servicePaths({
      env: { TOKENMAXXING_CONFIG_DIR: "/tmp/tokenmaxxing" },
      home: "/Users/alex",
      platform: "darwin",
    });

    expect(paths).not.toBeNull();
    const launchdPlist = renderLaunchdPlist(paths!);
    expect(launchdPlist).toContain("<string>/tmp/tokenmaxxing/tokenmaxxing.sh</string>");
    expect(launchdPlist).not.toContain("service-sync.sh");
    expect(launchdPlist).toContain("<key>StartInterval</key>");
    expect(launchdPlist).toContain("<integer>300</integer>");
    expect(launchdPlist).not.toContain("StartCalendarInterval");
    expect(renderSystemdTimer()).toContain("OnBootSec=5min");
    expect(renderSystemdTimer()).toContain("OnUnitActiveSec=5min");
    expect(renderSystemdTimer()).toContain("Persistent=true");
    expect(scheduleDescription()).toBe("syncs every 5 minutes");

    const windowsPaths = servicePaths({
      env: { TOKENMAXXING_CONFIG_DIR: "C:\\Users\\alex\\AppData\\Roaming\\tokenmaxxing" },
      home: "C:\\Users\\alex",
      platform: "win32",
    });

    expect(windowsPaths).not.toBeNull();
    expect(windowsTaskCreateArgs(windowsPaths!)).toEqual([
      "/Create",
      "/TN",
      "tokenmaxxing-sync",
      "/SC",
      "MINUTE",
      "/MO",
      "5",
      "/TR",
      '"C:\\Users\\alex\\AppData\\Roaming\\tokenmaxxing/service-sync.cmd"',
      "/F",
    ]);
  });
});

describe("legacyServiceWrapperPaths", () => {
  it("tracks old POSIX wrapper names for cleanup", () => {
    const paths = servicePaths({
      env: { TOKENMAXXING_CONFIG_DIR: "/tmp/tokenmaxxing" },
      home: "/Users/alex",
      platform: "darwin",
    });

    expect(paths).not.toBeNull();
    expect(legacyServiceWrapperPaths(paths!)).toEqual(["/tmp/tokenmaxxing/service-sync.sh"]);
  });

  it("does not add legacy cleanup paths for Windows task wrappers", () => {
    const paths = servicePaths({
      env: { TOKENMAXXING_CONFIG_DIR: "C:\\Users\\alex\\AppData\\Roaming\\tokenmaxxing" },
      home: "C:\\Users\\alex",
      platform: "win32",
    });

    expect(paths).not.toBeNull();
    expect(legacyServiceWrapperPaths(paths!)).toEqual([]);
  });
});

describe("windowsTaskNames", () => {
  it("includes the current task and legacy daily task names for cleanup", () => {
    expect(windowsTaskNames()).toEqual([
      "tokenmaxxing-sync",
      "tokenmaxxing-sync-0900",
      "tokenmaxxing-sync-1300",
      "tokenmaxxing-sync-1700",
      "tokenmaxxing-sync-2100",
    ]);
  });
});

describe("serviceStateJson", () => {
  it("omits legacy daily success dates from new writes", () => {
    expect(
      serviceStateJson({
        lastAttemptAt: "2026-06-16T10:00:00.000Z",
        lastSuccessAt: "2026-06-16T10:00:00.000Z",
        lastSuccessDate: "2026-06-16",
        version: 1,
      }),
    ).toEqual({
      lastAttemptAt: "2026-06-16T10:00:00.000Z",
      lastSuccessAt: "2026-06-16T10:00:00.000Z",
      version: 1,
    });
  });

  it("serializes enriched run diagnostics when present", () => {
    const state: ServiceState = {
      lastArch: "arm64",
      lastAttemptAt: "2026-06-16T10:00:00.000Z",
      lastAutoUpdated: true,
      lastCliVersion: "0.4.12",
      lastDurationMs: 1234,
      lastRows: 42,
      lastSince: "2026-06-16",
      lastSources: [
        {
          days: 3,
          models: 2,
          rows: 42,
          sessions: null,
          source: "codex",
          spendUsd: 12.34,
          status: "synced",
        },
      ],
      lastSuccessAt: "2026-06-16T10:00:01.000Z",
      lastUpserted: 42,
      version: 1,
    };

    expect(serviceStateJson(state)).toEqual(state);
  });
});

describe("serviceScheduledSyncSince", () => {
  it("uses the previous successful local date for scheduled syncs", () => {
    expect(
      serviceScheduledSyncSince(
        { lastSuccessAt: "2026-06-16T23:30:00.000Z", version: 1 },
        new Date("2026-06-17T00:05:00.000Z"),
        true,
      ),
    ).toBe("2026-06-16");
  });

  it("falls back to the legacy success date when no timestamp marker exists", () => {
    expect(
      serviceScheduledSyncSince(
        { lastSuccessDate: "2026-06-15", version: 1 },
        new Date("2026-06-17T12:00:00.000Z"),
        true,
      ),
    ).toBe("2026-06-15");
  });

  it("falls back to yesterday when no reliable marker exists", () => {
    expect(
      serviceScheduledSyncSince({ version: 1 }, new Date("2026-06-17T12:00:00.000Z"), true),
    ).toBe("2026-06-16");
    expect(
      serviceScheduledSyncSince(
        { lastSuccessAt: "not-a-date", version: 1 },
        new Date("2026-06-17T12:00:00.000Z"),
        true,
      ),
    ).toBe("2026-06-16");
    expect(
      serviceScheduledSyncSince(
        { lastSuccessAt: "2026-06-18T00:00:00.000Z", version: 1 },
        new Date("2026-06-17T12:00:00.000Z"),
        true,
      ),
    ).toBe("2026-06-16");
  });

  it("does not set since for manual service runs", () => {
    expect(
      serviceScheduledSyncSince(
        { lastSuccessAt: "2026-06-16T23:30:00.000Z", version: 1 },
        new Date("2026-06-17T00:05:00.000Z"),
        false,
      ),
    ).toBeUndefined();
  });
});

describe("service run state", () => {
  const syncResult: SyncResult = {
    dryRun: false,
    rows: 42,
    sourceResults: [
      {
        source: "codex",
        summary: { days: 3, models: 2, rows: 42, sessions: null, spendUsd: 12.34 },
      },
      { source: "gemini", summary: null },
    ],
    sources: {
      codex: { days: 3, models: 2, rows: 42, sessions: null, spendUsd: 12.34 },
      gemini: null,
    },
    status: "ok",
    upserted: 40,
  };

  it("captures success diagnostics and source summaries", () => {
    const state = serviceRunSuccessState(
      { lastError: "old error", version: 1 },
      {
        arch: "arm64",
        attemptAt: "2026-06-16T10:00:00.000Z",
        autoUpdated: false,
        durationMs: 1234,
        result: syncResult,
        since: "2026-06-16",
        successAt: "2026-06-16T10:00:01.000Z",
        version: "0.4.12",
      },
    );

    expect(state).toMatchObject({
      lastArch: "arm64",
      lastAttemptAt: "2026-06-16T10:00:00.000Z",
      lastAutoUpdated: false,
      lastCliVersion: "0.4.12",
      lastDurationMs: 1234,
      lastError: undefined,
      lastRows: 42,
      lastSince: "2026-06-16",
      lastSuccessAt: "2026-06-16T10:00:01.000Z",
      lastUpserted: 40,
      version: 1,
    });
    expect(state.lastSources).toEqual([
      {
        days: 3,
        models: 2,
        rows: 42,
        sessions: null,
        source: "codex",
        spendUsd: 12.34,
        status: "synced",
      },
      { source: "gemini", status: "skipped" },
    ]);
  });

  it("captures failure diagnostics without clobbering previous success", () => {
    const state = serviceRunFailureState(
      {
        lastRows: 42,
        lastSources: [{ source: "codex", status: "synced" }],
        lastSuccessAt: "2026-06-16T09:00:00.000Z",
        lastUpserted: 40,
        version: 1,
      },
      {
        arch: "arm64",
        attemptAt: "2026-06-16T10:00:00.000Z",
        durationMs: 222,
        error: "network unavailable",
        since: "2026-06-16",
        version: "0.4.12",
      },
    );

    expect(state).toMatchObject({
      lastArch: "arm64",
      lastAttemptAt: "2026-06-16T10:00:00.000Z",
      lastCliVersion: "0.4.12",
      lastDurationMs: 222,
      lastError: "network unavailable",
      lastRows: 42,
      lastSince: "2026-06-16",
      lastSuccessAt: "2026-06-16T09:00:00.000Z",
      lastUpserted: 40,
    });
  });

  it("renders structured service log lines without undefined fields", () => {
    const line = serviceRunLogLine(
      {
        lastArch: "arm64",
        lastAttemptAt: "2026-06-16T10:00:00.000Z",
        lastCliVersion: "0.4.12",
        lastDurationMs: 222,
        lastError: "network unavailable",
        lastSince: "2026-06-16",
        version: 1,
      },
      "failure",
    );

    expect(JSON.parse(JSON.stringify(line))).toMatchObject({
      arch: "arm64",
      durationMs: 222,
      error: "network unavailable",
      event: "service_run",
      since: "2026-06-16",
      status: "failure",
      version: "0.4.12",
    });
  });
});

describe("deterministicServiceJitterMs", () => {
  it("returns a stable delay within the configured jitter window", () => {
    const first = deterministicServiceJitterMs("device_123");
    const second = deterministicServiceJitterMs("device_123");

    expect(first).toBe(second);
    expect(first).toBeGreaterThanOrEqual(0);
    expect(first).toBeLessThanOrEqual(60 * 1000);
  });
});

describe("service lock status", () => {
  it("marks recent locks as active and old locks as stale", () => {
    const recent = serviceLockStatus(
      {
        acquiredAt: "2026-06-16T10:00:00.000Z",
        ownerId: "test",
        pid: 123,
        version: 1,
      },
      new Date("2026-06-16T11:59:59.000Z"),
    );
    const stale = serviceLockStatus(
      {
        acquiredAt: "2026-06-16T10:00:00.000Z",
        ownerId: "test",
        pid: 123,
        version: 1,
      },
      new Date("2026-06-16T12:00:00.000Z"),
    );

    expect(recent.locked).toBe(true);
    expect(recent.stale).toBe(false);
    expect(stale.locked).toBe(true);
    expect(stale.stale).toBe(true);
    expect(formatServiceLockStatus(stale)).toContain("(stale)");
  });
});

describe("formatServiceStatusAutoUpdate", () => {
  it("does not imply auto-update is enabled before service metadata exists", () => {
    expect(formatServiceStatusAutoUpdate(null)).toBe("unknown (service not installed)");
    expect(
      formatServiceStatusAutoUpdate({
        autoUpdate: false,
        backend: "launchd",
        commandPath: "/usr/local/bin/tokenmaxxing",
        installedAt: "2026-06-16T00:00:00.000Z",
        schedule: "daily",
        version: 1,
      }),
    ).toBe("disabled");
    expect(
      formatServiceStatusAutoUpdate({
        autoUpdate: true,
        autoUpdateManager: "npm",
        backend: "launchd",
        commandPath: "/usr/local/bin/tokenmaxxing",
        installedAt: "2026-06-16T00:00:00.000Z",
        schedule: "daily",
        version: 1,
      }),
    ).toBe("enabled via npm");
  });
});

describe("serviceInstallProgram", () => {
  it("starts browser login and installs the service when no stored token exists", async () => {
    const { layer, state } = makeTestLayer({
      initialConfig: {
        apiUrl: "https://api.tokenmaxxing.example",
        wwwUrl: "https://tokenmaxxing.example",
      },
    });
    const { installed, runtime, written } = makeInstallRuntime();

    const exit = await Effect.runPromiseExit(
      serviceInstallProgram({ autoUpdate: true, force: false, refresh: false }, runtime).pipe(
        Effect.provide(layer),
      ),
    );

    expect(exit._tag).toBe("Success");
    expect(state.logs).toContain("Not logged in; starting browser login");
    expect(state.browserUrls).toEqual(["https://tokenmaxxing.example/login/cli?code=ABC123"]);
    expect(state.writtenTokens).toEqual(["tmx_new"]);
    expect(state.logs).toContain("Detecting tokenmaxxing install");
    expect(state.logs).toContain("Found tokenmaxxing install");
    expect(state.logs).toContain("Writing service files");
    expect(state.logs).toContain("Service files written");
    expect(state.logs).toContain("Installing scheduler");
    expect(state.logs).toContain("Scheduler installed");
    expect(state.madeClients).toEqual([
      { baseUrl: "https://api.tokenmaxxing.example" },
      { baseUrl: "https://api.tokenmaxxing.example", token: "tmx_new" },
    ]);
    expect(written).toHaveLength(1);
    expect(installed).toEqual([written[0]?.paths]);
    expect(written[0]?.metadata).toMatchObject({
      autoUpdate: true,
      autoUpdateManager: "npm",
      commandPath: "/usr/local/bin/tokenmaxxing",
      installedAt: "2026-06-16T12:00:00.000Z",
    });
    expect(state.logs).toContain("Automatic sync installed");
  });

  it("relogs in and continues installing when the stored token is revoked", async () => {
    const { layer, state } = makeTestLayer({
      initialConfig: {
        apiUrl: "https://api.tokenmaxxing.example",
        token: "tmx_old",
        wwwUrl: "https://tokenmaxxing.example",
      },
      meError: unauthorizedError(),
    });
    const { installed, runtime, written } = makeInstallRuntime();

    const exit = await Effect.runPromiseExit(
      serviceInstallProgram({ autoUpdate: false, force: false, refresh: false }, runtime).pipe(
        Effect.provide(layer),
      ),
    );

    expect(exit._tag).toBe("Success");
    expect(state.clearedTokens).toBe(1);
    expect(state.logs).toContain("Stored token is no longer valid; starting browser login");
    expect(state.browserUrls).toEqual(["https://tokenmaxxing.example/login/cli?code=ABC123"]);
    expect(state.writtenTokens).toEqual(["tmx_new"]);
    expect(state.madeClients).toEqual([
      { baseUrl: "https://api.tokenmaxxing.example", token: "tmx_old" },
      { baseUrl: "https://api.tokenmaxxing.example" },
      { baseUrl: "https://api.tokenmaxxing.example", token: "tmx_new" },
    ]);
    expect(written).toHaveLength(1);
    expect(installed).toEqual([written[0]?.paths]);
    expect(written[0]?.metadata.autoUpdate).toBe(false);
  });

  it("still rejects TOKENMAXXING_API_TOKEN before starting login or installing", async () => {
    const { layer, state } = makeTestLayer({
      envTokenActive: true,
      initialConfig: {
        apiUrl: "https://api.tokenmaxxing.example",
        token: "tmx_env",
        wwwUrl: "https://tokenmaxxing.example",
      },
    });
    const { installed, runtime, written } = makeInstallRuntime();

    const exit = await Effect.runPromiseExit(
      serviceInstallProgram({ autoUpdate: true, force: false, refresh: false }, runtime).pipe(
        Effect.provide(layer),
      ),
    );

    expect(exit._tag).toBe("Failure");
    expect(failureTag(exit)).toBe("ServiceEnvTokenError");
    expect(state.browserUrls).toEqual([]);
    expect(state.writtenTokens).toEqual([]);
    expect(written).toEqual([]);
    expect(installed).toEqual([]);
  });

  it("does not install when login cannot run in a non-interactive shell", async () => {
    const { layer, state } = makeTestLayer({
      initialConfig: {
        apiUrl: "https://api.tokenmaxxing.example",
        wwwUrl: "https://tokenmaxxing.example",
      },
      interactive: false,
    });
    const { installed, runtime, written } = makeInstallRuntime();

    const exit = await Effect.runPromiseExit(
      serviceInstallProgram({ autoUpdate: true, force: false, refresh: false }, runtime).pipe(
        Effect.provide(layer),
      ),
    );

    expect(exit._tag).toBe("Failure");
    expect(failureTag(exit)).toBe("NonInteractiveLoginError");
    expect(state.logs).toContain("Not logged in; starting browser login");
    expect(state.browserUrls).toEqual([]);
    expect(state.writtenTokens).toEqual([]);
    expect(written).toEqual([]);
    expect(installed).toEqual([]);
  });

  it("does not start browser login when service install runs with --json", async () => {
    const { layer, state } = makeTestLayer({
      initialConfig: {
        apiUrl: "https://api.tokenmaxxing.example",
        wwwUrl: "https://tokenmaxxing.example",
      },
    });
    const { installed, runtime, written } = makeInstallRuntime();

    const exit = await Effect.runPromiseExit(
      serviceInstallProgram(
        { autoUpdate: true, force: false, json: true, refresh: false },
        runtime,
      ).pipe(Effect.provide(layer)),
    );

    expect(exit._tag).toBe("Failure");
    expect(failureTag(exit)).toBe("NotLoggedInError");
    expect(state.browserUrls).toEqual([]);
    expect(state.logs).toEqual([]);
    expect(state.writtenTokens).toEqual([]);
    expect(written).toEqual([]);
    expect(installed).toEqual([]);
  });

  it("refreshes service files without starting login", async () => {
    const { layer, state } = makeTestLayer({
      initialConfig: {
        apiUrl: "https://api.tokenmaxxing.example",
        wwwUrl: "https://tokenmaxxing.example",
      },
      interactive: false,
    });
    const { installed, runtime, written } = makeInstallRuntime();

    const exit = await Effect.runPromiseExit(
      serviceInstallProgram({ autoUpdate: false, force: false, refresh: true }, runtime).pipe(
        Effect.provide(layer),
      ),
    );

    expect(exit._tag).toBe("Success");
    expect(state.browserUrls).toEqual([]);
    expect(state.writtenTokens).toEqual([]);
    expect(state.logs).toContain("Detecting tokenmaxxing install");
    expect(state.logs).toContain("Found tokenmaxxing install");
    expect(state.logs).toContain("Writing service files");
    expect(state.logs).toContain("Service files written");
    expect(state.logs).toContain("Installing scheduler");
    expect(state.logs).toContain("Scheduler installed");
    expect(written).toHaveLength(1);
    expect(written[0]?.metadata.autoUpdate).toBe(false);
    expect(installed).toEqual([written[0]?.paths]);
  });
});

describe("command lookup", () => {
  it("finds an executable tokenmaxxing binary on PATH", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tokenmaxxing-service-"));

    try {
      const binary = join(dir, "tokenmaxxing");
      await writeFile(binary, "#!/bin/sh\n");
      await chmod(binary, 0o755);

      await expect(
        findCommandOnPath("tokenmaxxing", { PATH: ["/missing", dir].join(delimiter) }, "linux"),
      ).resolves.toBe(binary);
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("detects temporary package-runner paths", () => {
    expect(isEphemeralCommandPath("/home/alex/.npm/_npx/123/node_modules/.bin/tokenmaxxing")).toBe(
      true,
    );
    expect(isEphemeralCommandPath("/Users/alex/.bun/install/cache/@851-labs/tokenmaxxing")).toBe(
      true,
    );
    expect(
      isEphemeralCommandPath("/Users/alex/.local/state/fnm_multishells/123/bin/tokenmaxxing"),
    ).toBe(true);
    expect(isEphemeralCommandPath("/usr/local/bin/tokenmaxxing")).toBe(false);
  });

  it("uses stable resolved paths only for transient command shims", () => {
    const commandPath = "/Users/alex/.local/state/fnm_multishells/123/bin/tokenmaxxing";
    const resolvedCommandPath =
      "/Users/alex/.local/share/fnm/node-versions/v22.21.0/installation/lib/node_modules/@851-labs/tokenmaxxing/dist/index.js";

    expect(isTransientCommandShimPath(commandPath)).toBe(true);
    expect(durableTokenmaxxingCommandPath(commandPath, resolvedCommandPath)).toBe(
      resolvedCommandPath,
    );
    expect(durableTokenmaxxingCommandPath("/usr/local/bin/tokenmaxxing", resolvedCommandPath)).toBe(
      "/usr/local/bin/tokenmaxxing",
    );
    expect(
      durableTokenmaxxingCommandPath("/Users/alex/.volta/bin/tokenmaxxing", resolvedCommandPath),
    ).toBe("/Users/alex/.volta/bin/tokenmaxxing");
    expect(
      durableTokenmaxxingCommandPath(
        commandPath,
        "/Users/alex/.npm/_npx/123/node_modules/@851-labs/tokenmaxxing/dist/index.js",
      ),
    ).toBe(commandPath);
  });

  it("detects the package manager for common global install paths", () => {
    expect(
      detectAutoUpdateManager({
        commandPath: "/Users/alex/.bun/bin/tokenmaxxing",
        resolvedCommandPath:
          "/Users/alex/.bun/install/global/node_modules/@851-labs/tokenmaxxing/dist/index.js",
      }),
    ).toBe("bun");
    expect(
      detectAutoUpdateManager({
        commandPath: "/opt/homebrew/bin/tokenmaxxing",
        resolvedCommandPath: "/opt/homebrew/lib/node_modules/@851-labs/tokenmaxxing/dist/index.js",
      }),
    ).toBe("npm");
    expect(
      detectAutoUpdateManager({
        commandPath: "/Users/alex/Library/pnpm/tokenmaxxing",
        resolvedCommandPath: "/Users/alex/Library/pnpm/tokenmaxxing",
      }),
    ).toBe("pnpm");
    expect(
      detectAutoUpdateManager({
        commandPath: "/Users/alex/.yarn/bin/tokenmaxxing",
        resolvedCommandPath:
          "/Users/alex/.config/yarn/global/node_modules/@851-labs/tokenmaxxing/dist/index.js",
      }),
    ).toBe("yarn");
    expect(
      detectAutoUpdateManager({
        commandPath: "/opt/custom/bin/tokenmaxxing",
        resolvedCommandPath: "/opt/custom/bin/tokenmaxxing",
      }),
    ).toBeNull();
  });
});
