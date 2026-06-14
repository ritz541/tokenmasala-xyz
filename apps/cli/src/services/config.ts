import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { Context, Data, Effect, Layer } from "effect";

/**
 * Local CLI state at ~/.config/tokenmaxxing/config.json (override with
 * TOKENMAXXING_CONFIG_DIR; TOKENMAXXING_API_TOKEN wins over the stored
 * token for CI). `deviceId` is generated once at first login and survives
 * logout — it is the idempotency key for every usage row this machine has
 * ever pushed.
 */

interface CliConfig {
  apiUrl: string;
  deviceId?: string;
  token?: string;
  wwwUrl: string;
}

interface StoredCliConfig {
  config: CliConfig;
  exists: boolean;
  path: string;
}

interface ClearTokenResult {
  config: CliConfig;
  token?: string;
  tokenCleared: boolean;
}

class ConfigReadError extends Data.TaggedError("ConfigReadError")<{
  readonly cause: unknown;
  readonly path: string;
}> {
  override get message() {
    return `error: failed to read CLI config: ${this.path}\nhint: check TOKENMAXXING_CONFIG_DIR`;
  }
}

class ConfigWriteError extends Data.TaggedError("ConfigWriteError")<{
  readonly cause: unknown;
  readonly path: string;
}> {
  override get message() {
    return `error: failed to write CLI config: ${this.path}\nhint: check TOKENMAXXING_CONFIG_DIR permissions`;
  }
}

type ConfigError = ConfigReadError | ConfigWriteError;

type TokenmaxxingEnvironment = "development" | "production";

const runtimeConfigTable: Record<TokenmaxxingEnvironment, { apiUrl: string; wwwUrl: string }> = {
  development: {
    apiUrl: "http://api.tokenmaxxing.localhost:8788",
    wwwUrl: "http://tokenmaxxing.localhost:3002",
  },
  production: {
    apiUrl: "https://api.tokenmaxxing.sh",
    wwwUrl: "https://tokenmaxxing.sh",
  },
};

function getEnvironment(
  env: Record<string, string | undefined> = process.env,
): TokenmaxxingEnvironment {
  return env["TOKENMAXXING_ENV"] === "development" ? "development" : "production";
}

const localDevelopmentConfigDir = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "..",
  ".tmp",
  "tokenmaxxing-cli",
);

function getConfigPath(env: Record<string, string | undefined> = process.env): string {
  const configDir =
    getEnvironment(env) === "development"
      ? localDevelopmentConfigDir
      : (env["TOKENMAXXING_CONFIG_DIR"] ?? join(homedir(), ".config", "tokenmaxxing"));

  return join(configDir, "config.json");
}

function defaultConfig(env: Record<string, string | undefined>): CliConfig {
  const runtimeConfig = runtimeConfigTable[getEnvironment(env)];

  return {
    apiUrl: runtimeConfig.apiUrl,
    wwwUrl: runtimeConfig.wwwUrl,
  };
}

function applyEnvOverrides(config: CliConfig, env: Record<string, string | undefined>): CliConfig {
  const environment = getEnvironment(env);
  const runtimeConfig = runtimeConfigTable[environment];

  return {
    ...config,
    apiUrl:
      env["TOKENMAXXING_API_URL"] ??
      (environment === "development" ? runtimeConfig.apiUrl : config.apiUrl),
    wwwUrl:
      env["TOKENMAXXING_WWW_URL"] ??
      (environment === "development" ? runtimeConfig.wwwUrl : config.wwwUrl),
    token: env["TOKENMAXXING_API_TOKEN"] ?? config.token,
  };
}

function normalizeConfig(config: Partial<CliConfig>, fallback: CliConfig): CliConfig {
  return {
    ...config,
    apiUrl: config.apiUrl ?? fallback.apiUrl,
    wwwUrl: config.wwwUrl ?? fallback.wwwUrl,
  };
}

function readConfigFileProgram(
  path: string,
  fallback: CliConfig,
): Effect.Effect<StoredCliConfig, ConfigReadError> {
  return Effect.tryPromise({
    try: async () => JSON.parse(await readFile(path, "utf8")) as Partial<CliConfig>,
    catch: (cause) => cause,
  }).pipe(
    Effect.map((config) => ({
      config: normalizeConfig(config, fallback),
      exists: true,
      path,
    })),
    Effect.catch((cause) => {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") {
        return Effect.succeed({
          config: fallback,
          exists: false,
          path,
        });
      }

      return Effect.fail(new ConfigReadError({ cause, path }));
    }),
  );
}

function readConfigProgram(
  path = getConfigPath(),
  env: Record<string, string | undefined> = process.env,
): Effect.Effect<CliConfig, ConfigReadError> {
  return readConfigFileProgram(path, defaultConfig(env)).pipe(
    Effect.map((stored) => applyEnvOverrides(stored.config, env)),
  );
}

function writeConfigProgram(
  config: CliConfig,
  path = getConfigPath(),
): Effect.Effect<void, ConfigWriteError> {
  return Effect.tryPromise({
    try: async () => {
      await mkdir(dirname(path), {
        recursive: true,
      });
      await writeFile(path, `${JSON.stringify(config, null, 2)}\n`);
    },
    catch: (cause) => new ConfigWriteError({ cause, path }),
  });
}

/** Returns the stable device id, minting and persisting one on first use. */
function ensureDeviceIdProgram(
  path = getConfigPath(),
  env: Record<string, string | undefined> = process.env,
): Effect.Effect<string, ConfigError> {
  return Effect.gen(function* () {
    const { config } = yield* readConfigFileProgram(path, defaultConfig(env));
    if (config.deviceId !== undefined) {
      return config.deviceId;
    }

    const deviceId = crypto.randomUUID();
    yield* writeConfigProgram({ ...config, deviceId }, path);

    return deviceId;
  });
}

function writeTokenProgram(
  token: string,
  path = getConfigPath(),
  env: Record<string, string | undefined> = process.env,
): Effect.Effect<CliConfig, ConfigError> {
  return Effect.gen(function* () {
    const { config } = yield* readConfigFileProgram(path, defaultConfig(env));
    const nextConfig = {
      ...config,
      token,
    };

    yield* writeConfigProgram(nextConfig, path);

    return nextConfig;
  });
}

/** Drops the token but keeps deviceId — logout must not orphan history. */
function clearTokenProgram(
  path = getConfigPath(),
  env: Record<string, string | undefined> = process.env,
): Effect.Effect<ClearTokenResult, ConfigError> {
  return Effect.gen(function* () {
    const stored = yield* readConfigFileProgram(path, defaultConfig(env));
    const { token, ...nextConfig } = stored.config;

    if (!stored.exists || !token) {
      return {
        config: nextConfig,
        token,
        tokenCleared: false,
      };
    }

    yield* writeConfigProgram(nextConfig, path);

    return {
      config: nextConfig,
      token,
      tokenCleared: true,
    };
  });
}

function hasEnvTokenProgram(
  env: Record<string, string | undefined> = process.env,
): Effect.Effect<boolean> {
  return Effect.succeed(Boolean(env["TOKENMAXXING_API_TOKEN"]));
}

class ConfigService extends Context.Service<
  ConfigService,
  {
    readonly clearToken: typeof clearTokenProgram;
    readonly ensureDeviceId: typeof ensureDeviceIdProgram;
    readonly hasEnvToken: typeof hasEnvTokenProgram;
    readonly readConfig: typeof readConfigProgram;
    readonly writeToken: typeof writeTokenProgram;
  }
>()("ConfigService") {}

const ConfigLive = Layer.succeed(ConfigService)({
  clearToken: clearTokenProgram,
  ensureDeviceId: ensureDeviceIdProgram,
  hasEnvToken: hasEnvTokenProgram,
  readConfig: readConfigProgram,
  writeToken: writeTokenProgram,
});

export {
  clearTokenProgram,
  ConfigLive,
  ConfigReadError,
  ConfigService,
  ConfigWriteError,
  ensureDeviceIdProgram,
  getConfigPath,
  hasEnvTokenProgram,
  readConfigProgram,
  writeConfigProgram,
  writeTokenProgram,
};

export type { ClearTokenResult, CliConfig, ConfigError, StoredCliConfig };
