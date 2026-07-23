import { execFile } from "node:child_process";
import { Data, Effect } from "effect";
import type { UsageGithubDayInput } from "@tokenmaxxing/api-contract";

class GitCollectorError extends Data.TaggedError("GitCollectorError")<{
  readonly cause: unknown;
  readonly message: string;
}> {}

interface CollectGitTelemetryOptions {
  cwd?: string | undefined;
  since?: string | undefined;
}

function collectGitTelemetry(
  options: CollectGitTelemetryOptions = {},
): Effect.Effect<UsageGithubDayInput[], GitCollectorError> {
  return Effect.gen(function* () {
    const cwd = options.cwd ?? process.cwd();
    const args = ["log", "--no-merges", "--numstat", "--format=commit:%H%nauthor-date:%is"];

    if (options.since !== undefined) {
      args.push(`--since=${options.since}`);
    }

    const stdout = yield* execGit(args, cwd);
    return parseGitLogOutput(stdout);
  });
}

function execGit(args: string[], cwd: string): Effect.Effect<string, GitCollectorError> {
  return Effect.tryPromise({
    try: () =>
      new Promise<string>((resolve) => {
        execFile("git", args, { cwd, maxBuffer: 10 * 1024 * 1024 }, (error, stdout) => {
          if (error) {
            resolve("");
          } else {
            resolve(stdout);
          }
        });
      }),
    catch: (cause) => new GitCollectorError({ cause, message: "Failed executing git" }),
  });
}

function parseGitLogOutput(stdout: string): UsageGithubDayInput[] {
  if (!stdout.trim()) {
    return [];
  }

  const daysMap = new Map<
    string,
    {
      additions: number;
      commitCount: number;
      deletions: number;
      prCount: number;
      pushCount: number;
    }
  >();
  const lines = stdout.split("\n");

  let currentDate: string | null = null;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("author-date:")) {
      const isoString = trimmed.slice("author-date:".length).trim();
      currentDate = isoString.slice(0, 10);
      if (/^\d{4}-\d{2}-\d{2}$/.test(currentDate)) {
        const dayStats = daysMap.get(currentDate) ?? {
          additions: 0,
          commitCount: 0,
          deletions: 0,
          prCount: 0,
          pushCount: 0,
        };
        dayStats.commitCount += 1;
        dayStats.pushCount += 1;
        daysMap.set(currentDate, dayStats);
      }
    } else if (currentDate && /^\d+\s+\d+\s+/.test(trimmed)) {
      const parts = trimmed.split(/\s+/);
      const additions = Number.parseInt(parts[0]!, 10);
      const deletions = Number.parseInt(parts[1]!, 10);

      if (Number.isFinite(additions) && Number.isFinite(deletions)) {
        const dayStats = daysMap.get(currentDate);
        if (dayStats) {
          dayStats.additions += additions;
          dayStats.deletions += deletions;
        }
      }
    }
  }

  return [...daysMap.entries()]
    .map(([date, stats]) => ({
      additions: stats.additions,
      commitCount: stats.commitCount,
      date,
      deletions: stats.deletions,
      prCount: stats.prCount,
      pushCount: stats.pushCount,
    }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

export { GitCollectorError, collectGitTelemetry, parseGitLogOutput };
export type { CollectGitTelemetryOptions };
