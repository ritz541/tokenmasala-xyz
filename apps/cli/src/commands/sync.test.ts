import { Effect, Layer } from "effect";
import type { AuthUser } from "@tokenmaxxing/api-contract";
import { describe, expect, it } from "vitest";

import {
  ApiClientService,
  BrowserService,
  BrowserOpenError,
  ClockService,
  type CliConfig,
  ConfigService,
  ConsoleService,
  TerminalService,
  type TokenmaxxingApiClient,
} from "../services";
import { browserLoginEffect } from "./login";
import {
  formatSyncUsd,
  openProfileIfAvailable,
  renderSyncSuccess,
  renderSyncTable,
  resolveSyncAuth,
} from "./sync";

interface TestLayerOptions {
  browserOpenError?: BrowserOpenError;
  canOpenExternalBrowser?: boolean;
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
      open: (url) => {
        state.browserUrls.push(url);
        return options.browserOpenError === undefined
          ? Effect.succeed(undefined)
          : Effect.fail(options.browserOpenError);
      },
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
      canOpenExternalBrowser: Effect.succeed(options.canOpenExternalBrowser ?? true),
      isInteractive: Effect.succeed(options.interactive ?? true),
    }),
  );

  return { layer, state };
}

function unauthorizedError() {
  return Object.assign(new Error("unauthorized"), { _tag: "Unauthorized" as const });
}

describe("formatSyncUsd", () => {
  it("matches the site USD formatting for small and large values", () => {
    expect(formatSyncUsd(99.5)).toBe("$99.50");
    expect(formatSyncUsd(100)).toBe("$100");
    expect(formatSyncUsd(2_609.77)).toBe("$2,610");
    expect(formatSyncUsd(11_802.15)).toBe("$11,802");
  });
});

describe("renderSyncTable", () => {
  it("renders a readable source summary table without colors when NO_COLOR is set", () => {
    const table = renderSyncTable(
      [
        {
          source: "claude",
          summary: { days: 17, models: 7, rows: 42, sessions: 17, spendUsd: 2_672 },
        },
        {
          source: "opencode",
          summary: {
            days: 85,
            models: 9,
            rows: 1_234,
            sessions: null,
            spendUsd: 1_699,
          },
        },
        { source: "gemini", summary: null },
      ],
      { env: { NO_COLOR: "" } },
    );

    expect(table).not.toContain("\x1b");
    expect(table.split("\n").map((line) => line.trim().split(/\s{2,}/))).toEqual([
      ["Agent", "Status", "Days", "Sessions", "Models", "Spend"],
      ["claude", "synced", "17", "17", "7", "$2,672"],
      ["opencode", "synced", "85", "-", "9", "$1,699"],
      ["gemini", "skipped", "-", "-", "-", "-"],
    ]);
  });

  it("colors synced and skipped statuses when colors are enabled", () => {
    const table = renderSyncTable(
      [
        {
          source: "claude",
          summary: { days: 17, models: 7, rows: 42, sessions: 17, spendUsd: 2_672 },
        },
        { source: "gemini", summary: null },
      ],
      { env: {} },
    );

    expect(table).toContain("\x1b[32msynced");
    expect(table).toContain("\x1b[33mskipped");
  });
});

describe("renderSyncSuccess", () => {
  it("renders a concise success message with a highlighted profile link", () => {
    const output = renderSyncSuccess("https://tokenmaxxing.example/alex", { env: {} });

    expect(output).toBe(
      "\x1b[32mSync complete.\x1b[0m\nProfile: \x1b[36;4mhttps://tokenmaxxing.example/alex\x1b[0m",
    );
  });

  it("respects NO_COLOR", () => {
    expect(renderSyncSuccess("https://tokenmaxxing.example/alex", { env: { NO_COLOR: "" } })).toBe(
      "Sync complete.\nProfile: https://tokenmaxxing.example/alex",
    );
  });
});

describe("resolveSyncAuth", () => {
  it("keeps --json machine-readable by failing without browser login when no token exists", async () => {
    const { layer, state } = makeTestLayer({
      initialConfig: {
        apiUrl: "https://api.tokenmaxxing.example",
        wwwUrl: "https://tokenmaxxing.example",
      },
    });

    const exit = await Effect.runPromiseExit(
      resolveSyncAuth({ json: true }).pipe(Effect.provide(layer)),
    );

    expect(exit._tag).toBe("Failure");
    expect(state.browserUrls).toEqual([]);
    expect(state.writtenTokens).toEqual([]);
  });

  it("starts browser login and returns fresh auth for human sync when no token exists", async () => {
    const { layer, state } = makeTestLayer({
      initialConfig: {
        apiUrl: "https://api.tokenmaxxing.example",
        wwwUrl: "https://tokenmaxxing.example",
      },
    });

    const exit = await Effect.runPromiseExit(
      resolveSyncAuth({ json: false }).pipe(Effect.provide(layer)),
    );

    expect(exit._tag).toBe("Success");
    if (exit._tag !== "Success") {
      throw new Error("expected resolveSyncAuth to succeed");
    }

    const auth = exit.value;
    expect(auth.config.token).toBe("tmx_new");
    expect(auth.user.login).toBe("alex");
    expect(state.browserUrls).toEqual(["https://tokenmaxxing.example/login/cli?code=ABC123"]);
    expect(state.writtenTokens).toEqual(["tmx_new"]);
    expect(state.madeClients).toEqual([
      { baseUrl: "https://api.tokenmaxxing.example" },
      { baseUrl: "https://api.tokenmaxxing.example", token: "tmx_new" },
    ]);
    expect(state.logs).toContain("Not logged in; starting browser login.");
  });

  it("skips external browser launch in interactive headless shells and completes manual login", async () => {
    const { layer, state } = makeTestLayer({
      canOpenExternalBrowser: false,
      initialConfig: {
        apiUrl: "https://api.tokenmaxxing.example",
        wwwUrl: "https://tokenmaxxing.example",
      },
    });

    const exit = await Effect.runPromiseExit(
      resolveSyncAuth({ json: false }).pipe(Effect.provide(layer)),
    );

    expect(exit._tag).toBe("Success");
    expect(state.browserUrls).toEqual([]);
    expect(state.errors).toContain("Open the URL above in your browser to continue.");
    expect(state.writtenTokens).toEqual(["tmx_new"]);
  });

  it("continues human login when automatic browser launch fails", async () => {
    const { layer, state } = makeTestLayer({
      browserOpenError: new BrowserOpenError({ cause: "xdg-open missing" }),
      initialConfig: {
        apiUrl: "https://api.tokenmaxxing.example",
        wwwUrl: "https://tokenmaxxing.example",
      },
    });

    const exit = await Effect.runPromiseExit(
      resolveSyncAuth({ json: false }).pipe(Effect.provide(layer)),
    );

    expect(exit._tag).toBe("Success");
    expect(state.browserUrls).toEqual(["https://tokenmaxxing.example/login/cli?code=ABC123"]);
    expect(state.errors).toContain(
      "Could not open a browser automatically; open the URL above manually.",
    );
    expect(state.writtenTokens).toEqual(["tmx_new"]);
  });

  it("clears a revoked stored token and restarts browser login for human sync", async () => {
    const { layer, state } = makeTestLayer({
      initialConfig: {
        apiUrl: "https://api.tokenmaxxing.example",
        token: "tmx_old",
        wwwUrl: "https://tokenmaxxing.example",
      },
      meError: unauthorizedError(),
    });

    const exit = await Effect.runPromiseExit(
      resolveSyncAuth({ json: false }).pipe(Effect.provide(layer)),
    );

    expect(exit._tag).toBe("Success");
    if (exit._tag !== "Success") {
      throw new Error("expected resolveSyncAuth to succeed");
    }

    const auth = exit.value;
    expect(auth.config.token).toBe("tmx_new");
    expect(state.clearedTokens).toBe(1);
    expect(state.browserUrls).toEqual(["https://tokenmaxxing.example/login/cli?code=ABC123"]);
    expect(state.madeClients).toEqual([
      { baseUrl: "https://api.tokenmaxxing.example", token: "tmx_old" },
      { baseUrl: "https://api.tokenmaxxing.example" },
      { baseUrl: "https://api.tokenmaxxing.example", token: "tmx_new" },
    ]);
  });

  it("does not replace an unauthorized env token", async () => {
    const { layer, state } = makeTestLayer({
      envTokenActive: true,
      initialConfig: {
        apiUrl: "https://api.tokenmaxxing.example",
        token: "tmx_env",
        wwwUrl: "https://tokenmaxxing.example",
      },
      meError: unauthorizedError(),
    });

    const exit = await Effect.runPromiseExit(
      resolveSyncAuth({ json: false }).pipe(Effect.provide(layer)),
    );

    expect(exit._tag).toBe("Failure");
    expect(state.browserUrls).toEqual([]);
    expect(state.clearedTokens).toBe(0);
    expect(state.writtenTokens).toEqual([]);
  });
});

describe("browserLoginEffect", () => {
  it("keeps --json login from starting when external browser launch is unavailable", async () => {
    const { layer, state } = makeTestLayer({
      canOpenExternalBrowser: false,
      initialConfig: {
        apiUrl: "https://api.tokenmaxxing.example",
        wwwUrl: "https://tokenmaxxing.example",
      },
    });

    const exit = await Effect.runPromiseExit(
      browserLoginEffect({ json: true }).pipe(Effect.provide(layer)),
    );

    expect(exit._tag).toBe("Failure");
    expect(state.browserUrls).toEqual([]);
    expect(state.madeClients).toEqual([]);
    expect(state.writtenTokens).toEqual([]);
  });
});

describe("openProfileIfAvailable", () => {
  it("opens the profile URL when an external browser is available", async () => {
    const { layer, state } = makeTestLayer({
      initialConfig: {
        apiUrl: "https://api.tokenmaxxing.example",
        wwwUrl: "https://tokenmaxxing.example",
      },
    });

    await Effect.runPromise(
      openProfileIfAvailable("https://tokenmaxxing.example/alex").pipe(Effect.provide(layer)),
    );

    expect(state.browserUrls).toEqual(["https://tokenmaxxing.example/alex"]);
    expect(state.errors).toEqual([]);
  });

  it("skips profile opening when no external browser is available", async () => {
    const { layer, state } = makeTestLayer({
      canOpenExternalBrowser: false,
      initialConfig: {
        apiUrl: "https://api.tokenmaxxing.example",
        wwwUrl: "https://tokenmaxxing.example",
      },
    });

    await Effect.runPromise(
      openProfileIfAvailable("https://tokenmaxxing.example/alex").pipe(Effect.provide(layer)),
    );

    expect(state.browserUrls).toEqual([]);
    expect(state.errors).toEqual([]);
  });

  it("keeps sync successful when profile opening fails", async () => {
    const { layer, state } = makeTestLayer({
      browserOpenError: new BrowserOpenError({ cause: "xdg-open missing" }),
      initialConfig: {
        apiUrl: "https://api.tokenmaxxing.example",
        wwwUrl: "https://tokenmaxxing.example",
      },
    });

    await Effect.runPromise(
      openProfileIfAvailable("https://tokenmaxxing.example/alex").pipe(Effect.provide(layer)),
    );

    expect(state.browserUrls).toEqual(["https://tokenmaxxing.example/alex"]);
    expect(state.errors).toContain(
      "Could not open profile automatically; open the URL above manually.",
    );
  });
});
