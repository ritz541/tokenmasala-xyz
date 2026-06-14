import { Effect, Layer } from "effect";
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
import { resolveSyncAuth } from "./sync";

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
                verificationUri: "https://tokenmaxxing.example/cli-auth?code=ABC123",
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
      isInteractive: Effect.succeed(options.interactive ?? true),
    }),
  );

  return { layer, state };
}

function unauthorizedError() {
  return Object.assign(new Error("unauthorized"), { _tag: "Unauthorized" as const });
}

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
    expect(state.browserUrls).toEqual(["https://tokenmaxxing.example/cli-auth?code=ABC123"]);
    expect(state.writtenTokens).toEqual(["tmx_new"]);
    expect(state.madeClients).toEqual([
      { baseUrl: "https://api.tokenmaxxing.example" },
      { baseUrl: "https://api.tokenmaxxing.example", token: "tmx_new" },
    ]);
    expect(state.logs).toContain("Not logged in; opening browser login.");
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
    expect(state.browserUrls).toEqual(["https://tokenmaxxing.example/cli-auth?code=ABC123"]);
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
