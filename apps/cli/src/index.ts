#!/usr/bin/env node

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Layer } from "effect";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { runTokenmaxxingCommand } from "./commands/root";
import { isJsonArgv, isVerboseArgv, renderCliFailure } from "./errors";
import { CliServicesLive } from "./services";

function mainEffect(argv = process.argv.slice(2)) {
  const normalizedArgv = normalizeRootVersionArgv(argv);

  return runTokenmaxxingCommand(normalizedArgv).pipe(
    Effect.tapCause((cause) =>
      renderCliFailure(cause, {
        json: isJsonArgv(normalizedArgv),
        verbose: isVerboseArgv(normalizedArgv),
      }),
    ),
  );
}

function normalizeRootVersionArgv(argv: readonly string[]) {
  if (argv.length === 1 && argv[0] === "-v") {
    return ["--version"];
  }

  return argv;
}

function realpathOrOriginal(path: string) {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

function pathFromMetaUrl(metaUrl: string) {
  try {
    return fileURLToPath(metaUrl);
  } catch {
    return null;
  }
}

function isMainModule(
  metaUrl = import.meta.url,
  argv1 = process.argv[1],
  metaMain = (import.meta as { main?: boolean | undefined }).main,
) {
  if (metaMain === true) {
    return true;
  }

  const modulePath = pathFromMetaUrl(metaUrl);
  return (
    argv1 !== undefined &&
    modulePath !== null &&
    realpathOrOriginal(modulePath) === realpathOrOriginal(argv1)
  );
}

if (isMainModule()) {
  NodeRuntime.runMain(
    mainEffect().pipe(Effect.provide(Layer.mergeAll(CliServicesLive, NodeServices.layer))),
    {
      disableErrorReporting: true,
    },
  );
}

export { isMainModule, mainEffect, normalizeRootVersionArgv };
