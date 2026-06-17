import { Data, Effect } from "effect";
import { Command, Flag } from "effect/unstable/cli";

import { humanFrame, humanLog, writeJson } from "../output";
import {
  autoUpdateCommandDescription,
  type AutoUpdateManager,
  type CommandInstall,
  findTokenmaxxingCommandInstall,
  isEphemeralCommandPath,
  isServiceInstalled,
  readServiceMetadata,
  refreshServiceAfterUpdate,
  runPackageManagerUpdate,
  servicePathsEffect,
  type ServiceMetadata,
  type ServicePaths,
} from "./service";

type ServiceRefreshResult =
  | {
      _tag: "failed";
      cause: unknown;
    }
  | {
      _tag: "not-installed";
    }
  | {
      _tag: "refreshed";
    };

class UpgradeCommandNotFoundError extends Data.TaggedError("UpgradeCommandNotFoundError")<{}> {
  override message =
    "error: tokenmaxxing is not installed globally\nhint: install it with bun, npm, pnpm, or yarn";
}

class UpgradeEphemeralCommandError extends Data.TaggedError("UpgradeEphemeralCommandError")<{
  readonly commandPath: string;
}> {
  override get message() {
    return `error: tokenmaxxing resolved to a temporary runner path\npath: ${this.commandPath}\nhint: install it globally with bun, npm, pnpm, or yarn before running tokenmaxxing upgrade`;
  }
}

class UpgradeManagerError extends Data.TaggedError("UpgradeManagerError")<{
  readonly commandPath: string;
  readonly resolvedCommandPath: string;
}> {
  override get message() {
    return `error: could not detect how tokenmaxxing was globally installed\npath: ${this.commandPath}\nresolved path: ${this.resolvedCommandPath}\nhint: reinstall with bun, npm, pnpm, or yarn`;
  }
}

class UpgradeFailedError extends Data.TaggedError("UpgradeFailedError")<{
  readonly cause: unknown;
}> {
  override message =
    "error: failed to upgrade tokenmaxxing\nhint: try upgrading with your package manager";
}

const upgradeCommand = Command.make(
  "upgrade",
  {
    json: Flag.boolean("json").pipe(Flag.withDescription("Output machine-readable JSON")),
  },
  ({ json }) => upgradeEffect({ json }),
).pipe(Command.withDescription("Upgrade the globally installed CLI"));

function upgradeEffect(options: { json?: boolean | undefined } = {}) {
  return humanFrame("Upgrade", options, upgradeProgram({}, options));
}

function upgradeProgram(
  runtime: {
    env?: Record<string, string | undefined>;
    findCommandInstall?: () => Effect.Effect<CommandInstall | null, unknown>;
    home?: string;
    isServiceInstalled?: (paths: ServicePaths) => Effect.Effect<boolean, never>;
    platform?: NodeJS.Platform;
    readServiceMetadata?: (path: string) => Effect.Effect<ServiceMetadata | null, never>;
    refreshService?: (options: {
      autoUpdate: boolean;
      commandPath: string;
    }) => Effect.Effect<void, unknown>;
    runPackageManagerUpdate?: (manager: AutoUpdateManager) => Effect.Effect<void, unknown>;
  } = {},
  options: { json?: boolean | undefined } = {},
) {
  return Effect.gen(function* () {
    const env = runtime.env ?? process.env;
    const platform = runtime.platform ?? process.platform;
    const install = yield* (
      runtime.findCommandInstall ?? (() => findTokenmaxxingCommandInstall(env, platform))
    )().pipe(
      Effect.flatMap((value) =>
        value === null ? Effect.fail(new UpgradeCommandNotFoundError()) : Effect.succeed(value),
      ),
    );

    if (isEphemeralCommandPath(install.commandPath)) {
      return yield* Effect.fail(
        new UpgradeEphemeralCommandError({ commandPath: install.commandPath }),
      );
    }

    const manager = install.autoUpdateManager;
    if (manager === null) {
      return yield* Effect.fail(
        new UpgradeManagerError({
          commandPath: install.commandPath,
          resolvedCommandPath: install.resolvedCommandPath,
        }),
      );
    }

    const command = autoUpdateCommandDescription(manager);

    yield* humanLog("info", `Detected package manager: ${manager}`, options);
    yield* humanLog("info", `Running: ${command}`, options);

    yield* (runtime.runPackageManagerUpdate ?? runPackageManagerUpdate)(manager).pipe(
      Effect.mapError((cause) => new UpgradeFailedError({ cause })),
    );

    yield* humanLog("success", "Upgraded tokenmaxxing.", options);

    const refreshResult = yield* refreshInstalledService(install, runtime);
    if (options.json) {
      yield* writeJson({
        command,
        packageManager: manager,
        service: serviceRefreshJson(refreshResult),
        status: "ok",
      });
      return;
    }

    yield* humanLog("info", formatServiceRefreshResult(refreshResult), options);
  });
}

function refreshInstalledService(
  install: CommandInstall,
  runtime: {
    env?: Record<string, string | undefined>;
    home?: string;
    isServiceInstalled?: (paths: ServicePaths) => Effect.Effect<boolean, never>;
    platform?: NodeJS.Platform;
    readServiceMetadata?: (path: string) => Effect.Effect<ServiceMetadata | null, never>;
    refreshService?: (options: {
      autoUpdate: boolean;
      commandPath: string;
    }) => Effect.Effect<void, unknown>;
  },
): Effect.Effect<ServiceRefreshResult, never> {
  return Effect.gen(function* () {
    const paths = yield* servicePathsEffect(runtime.env, runtime.home, runtime.platform).pipe(
      Effect.match({
        onFailure: () => null,
        onSuccess: (value) => value,
      }),
    );
    if (paths === null) {
      return { _tag: "not-installed" as const };
    }

    const installed = yield* (runtime.isServiceInstalled ?? isServiceInstalled)(paths);
    if (!installed) {
      return { _tag: "not-installed" as const };
    }

    const metadata = yield* (runtime.readServiceMetadata ?? readServiceMetadata)(
      paths.metadataPath,
    );
    const autoUpdate = metadata?.autoUpdate ?? true;
    const result = yield* (runtime.refreshService ?? refreshServiceAfterUpdate)({
      autoUpdate,
      commandPath: install.commandPath,
    }).pipe(
      Effect.match({
        onFailure: (cause) => ({ _tag: "failed" as const, cause }),
        onSuccess: () => ({ _tag: "refreshed" as const }),
      }),
    );

    return result;
  });
}

function formatServiceRefreshResult(result: ServiceRefreshResult): string {
  switch (result._tag) {
    case "failed":
      return "Service: refresh failed; run tokenmaxxing service install if needed.";
    case "not-installed":
      return "Service: not installed.";
    case "refreshed":
      return "Service: refreshed.";
  }
}

function serviceRefreshJson(result: ServiceRefreshResult) {
  return result._tag === "failed"
    ? { status: result._tag, recoverable: true }
    : { status: result._tag };
}

export {
  formatServiceRefreshResult,
  refreshInstalledService,
  upgradeCommand,
  upgradeEffect,
  upgradeProgram,
  UpgradeCommandNotFoundError,
  UpgradeEphemeralCommandError,
  UpgradeFailedError,
  UpgradeManagerError,
};
