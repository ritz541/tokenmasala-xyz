import { Data, Effect } from "effect";
import { Command } from "effect/unstable/cli";

import { ConsoleService } from "../services";
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

class UpdateCommandNotFoundError extends Data.TaggedError("UpdateCommandNotFoundError")<{}> {
  override message =
    "error: tokenmaxxing is not installed globally\nhint: install it with bun, npm, pnpm, or yarn";
}

class UpdateEphemeralCommandError extends Data.TaggedError("UpdateEphemeralCommandError")<{
  readonly commandPath: string;
}> {
  override get message() {
    return `error: tokenmaxxing resolved to a temporary runner path\npath: ${this.commandPath}\nhint: install it globally with bun, npm, pnpm, or yarn before running tokenmaxxing update`;
  }
}

class UpdateManagerError extends Data.TaggedError("UpdateManagerError")<{
  readonly commandPath: string;
  readonly resolvedCommandPath: string;
}> {
  override get message() {
    return `error: could not detect how tokenmaxxing was globally installed\npath: ${this.commandPath}\nresolved path: ${this.resolvedCommandPath}\nhint: reinstall with bun, npm, pnpm, or yarn`;
  }
}

class UpdateFailedError extends Data.TaggedError("UpdateFailedError")<{
  readonly cause: unknown;
}> {
  override message =
    "error: failed to update tokenmaxxing\nhint: try updating with your package manager";
}

const updateCommand = Command.make("update", {}, () => updateEffect()).pipe(
  Command.withDescription("Update the globally installed CLI"),
);

function updateEffect() {
  return updateProgram();
}

function updateProgram(
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
) {
  return Effect.gen(function* () {
    const console = yield* Effect.service(ConsoleService);
    const env = runtime.env ?? process.env;
    const platform = runtime.platform ?? process.platform;
    const install = yield* (
      runtime.findCommandInstall ?? (() => findTokenmaxxingCommandInstall(env, platform))
    )().pipe(
      Effect.flatMap((value) =>
        value === null ? Effect.fail(new UpdateCommandNotFoundError()) : Effect.succeed(value),
      ),
    );

    if (isEphemeralCommandPath(install.commandPath)) {
      return yield* Effect.fail(
        new UpdateEphemeralCommandError({ commandPath: install.commandPath }),
      );
    }

    const manager = install.autoUpdateManager;
    if (manager === null) {
      return yield* Effect.fail(
        new UpdateManagerError({
          commandPath: install.commandPath,
          resolvedCommandPath: install.resolvedCommandPath,
        }),
      );
    }

    yield* Effect.sync(() => {
      console.log(`Detected package manager: ${manager}`);
      console.log(`Running: ${autoUpdateCommandDescription(manager)}`);
    });

    yield* (runtime.runPackageManagerUpdate ?? runPackageManagerUpdate)(manager).pipe(
      Effect.mapError((cause) => new UpdateFailedError({ cause })),
    );

    yield* Effect.sync(() => {
      console.log("Updated tokenmaxxing.");
    });

    const refreshResult = yield* refreshInstalledService(install, runtime);
    yield* Effect.sync(() => {
      console.log(formatServiceRefreshResult(refreshResult));
    });
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

export {
  formatServiceRefreshResult,
  refreshInstalledService,
  updateCommand,
  updateEffect,
  updateProgram,
  UpdateCommandNotFoundError,
  UpdateEphemeralCommandError,
  UpdateFailedError,
  UpdateManagerError,
};
