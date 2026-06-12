import { execFile } from "node:child_process";

import { Data, Effect, Option } from "effect";

import type { CcusageDay } from "./schema";
import { decodeDailyReport } from "./schema";
import type { CcusageSource } from "./sources";

/**
 * Shells out to `bunx ccusage@^20 <source> daily --json --breakdown` (npx
 * fallback only when bunx itself is missing). A source that fails, is not
 * installed, or has no local data resolves to none — one broken agent must
 * never abort the whole sync.
 */

const CCUSAGE_SPEC = "ccusage@^20";
const RUN_TIMEOUT_MS = 180_000;

class CcusageRunError extends Data.TaggedError("CcusageRunError")<{
  readonly cause: unknown;
  readonly source: string;
}> {}

interface RunOptions {
  /** YYYY-MM-DD; forwarded to ccusage as compact YYYYMMDD. */
  since?: string | undefined;
}

function runCcusageSource(
  source: CcusageSource,
  options: RunOptions = {},
): Effect.Effect<Option.Option<readonly CcusageDay[]>> {
  // calculate mode prices every token at current list rates ("API-equivalent
  // cost") — auto mode trusts pre-recorded costs, which subscription usage
  // records as $0 and would zero out codex/opencode on the leaderboard.
  const args = [source.subcommand, "daily", "--json", "--breakdown", "--mode", "calculate"];
  if (options.since !== undefined) {
    args.push("--since", options.since.replaceAll("-", ""));
  }

  return Effect.gen(function* () {
    const stdout = yield* execCcusage(args, source.source);
    const report = yield* decodeDailyReport(JSON.parse(stdout)).pipe(
      Effect.mapError((cause) => new CcusageRunError({ cause, source: source.source })),
    );

    return Option.some(report.daily);
  }).pipe(
    // Missing runner, no data dir, malformed output: skip the source.
    Effect.catchCause(() => Effect.succeedNone),
  );
}

function execCcusage(args: string[], source: string): Effect.Effect<string, CcusageRunError> {
  const run = (command: string, commandArgs: string[]) =>
    Effect.callback<string, CcusageRunError>((resume) => {
      const child = execFile(
        command,
        commandArgs,
        { maxBuffer: 256 * 1024 * 1024, timeout: RUN_TIMEOUT_MS },
        (error, stdout) => {
          if (error) {
            resume(Effect.fail(new CcusageRunError({ cause: error, source })));
          } else {
            resume(Effect.succeed(stdout));
          }
        },
      );

      return Effect.sync(() => {
        child.kill();
      });
    });

  return run("bunx", [CCUSAGE_SPEC, ...args]).pipe(
    Effect.catch((error: CcusageRunError) =>
      isMissingCommand(error.cause)
        ? run("npx", ["-y", CCUSAGE_SPEC, ...args])
        : Effect.fail(error),
    ),
  );
}

function isMissingCommand(cause: unknown): boolean {
  return (cause as NodeJS.ErrnoException)?.code === "ENOENT";
}

export { CcusageRunError, runCcusageSource };

export type { RunOptions };
