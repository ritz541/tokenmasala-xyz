import { Cause, Effect, Option } from "effect";
import { CliError, Flag, GlobalFlag } from "effect/unstable/cli";

import { ConsoleService } from "./services";

/**
 * Failure rendering for the whole CLI: tagged errors whose message starts
 * with "error:" reach the user verbatim (with a hint line); everything else
 * collapses to a generic failure unless --verbose is set.
 */

const userFacingErrorTags = new Set([
  "AlreadyLoggedInError",
  "ConfigReadError",
  "ConfigWriteError",
  "LoginSleepError",
  "LoginTimeoutError",
  "NonInteractiveLoginError",
  "NotLoggedInError",
  "OpenBrowserError",
  "PollCliLoginError",
  "StartCliLoginError",
  "SyncPushError",
  "WhoamiError",
  "WriteCliTokenError",
]);

const verboseGlobalFlag = GlobalFlag.setting("verbose")({
  flag: Flag.boolean("verbose").pipe(
    Flag.withDescription("Print internal stack traces on failures"),
  ),
});

function isVerboseArgv(argv: readonly string[]) {
  let verbose = false;

  for (const value of argv) {
    if (value === "--") {
      break;
    }

    if (value === "--verbose") {
      verbose = true;
      continue;
    }

    if (value === "--no-verbose") {
      verbose = false;
    }
  }

  return verbose;
}

function renderCliFailure<E>(
  cause: Cause.Cause<E>,
  options: {
    verbose: boolean;
  },
) {
  const message = messageForCause(cause);

  if (!message) {
    return Effect.void;
  }

  return Effect.gen(function* () {
    const output = yield* Effect.service(ConsoleService);

    yield* Effect.sync(() => {
      output.error(message);

      if (options.verbose) {
        output.error(`debug:\n${Cause.pretty(cause)}`);
      }
    });
  });
}

function messageForCause<E>(cause: Cause.Cause<E>) {
  if (Cause.hasInterruptsOnly(cause)) {
    return undefined;
  }

  const error = Cause.findErrorOption(cause);

  if (Option.isSome(error)) {
    if (isShowHelpError(error.value)) {
      return undefined;
    }

    if (isUserFacingCliError(error.value)) {
      return error.value.message;
    }
  }

  return "error: unexpected CLI failure\nhint: rerun with --verbose and report the output";
}

function isShowHelpError(value: unknown) {
  return CliError.isCliError(value) && value._tag === "ShowHelp";
}

function isUserFacingCliError(value: unknown): value is Error {
  const tag = (value as { _tag?: unknown })._tag;

  return (
    value instanceof Error &&
    typeof tag === "string" &&
    userFacingErrorTags.has(tag) &&
    value.message.startsWith("error:")
  );
}

export { isUserFacingCliError, isVerboseArgv, renderCliFailure, verboseGlobalFlag };
