#!/usr/bin/env bun

import * as BunRuntime from "@effect/platform-bun/BunRuntime";
import * as BunServices from "@effect/platform-bun/BunServices";
import { Effect, Layer } from "effect";

import { runTokenmaxxingCommand } from "./commands/root";
import { isVerboseArgv, renderCliFailure } from "./errors";
import { CliServicesLive } from "./services";

function mainEffect(argv = process.argv.slice(2)) {
  const normalizedArgv = normalizeRootVersionArgv(argv);

  return runTokenmaxxingCommand(normalizedArgv).pipe(
    Effect.tapCause((cause) =>
      renderCliFailure(cause, {
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

if (import.meta.main) {
  BunRuntime.runMain(
    mainEffect().pipe(Effect.provide(Layer.mergeAll(CliServicesLive, BunServices.layer))),
    {
      disableErrorReporting: true,
    },
  );
}

export { mainEffect, normalizeRootVersionArgv };
