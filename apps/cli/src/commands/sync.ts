import { hostname } from "node:os";

import { Data, Effect, Option } from "effect";
import { Command, Flag } from "effect/unstable/cli";
import type { AuthUser, UsageDayInput } from "@tokenmaxxing/api-contract";

import { aggregateDays, summarize } from "../ccusage/aggregate";
import { runCcusageSource } from "../ccusage/runner";
import { DEFAULT_SOURCE_NAMES, resolveSources } from "../ccusage/sources";
import {
  ApiClientService,
  type CliConfig,
  ConfigService,
  ConsoleService,
  type TokenmaxxingApiClient,
} from "../services";
import { browserLoginEffect } from "./login";
import { NotLoggedInError } from "./whoami";

class SyncPushError extends Data.TaggedError("SyncPushError")<{
  readonly cause: unknown;
}> {
  override message =
    "error: failed to push usage to tokenmaxxing\nhint: check your network and run tokenmaxxing sync again";
}

class UnknownSourceError extends Data.TaggedError("UnknownSourceError")<{
  readonly names: string[];
}> {
  override get message() {
    return `error: unknown source${this.names.length > 1 ? "s" : ""}: ${this.names.join(", ")}\nhint: valid sources are ${DEFAULT_SOURCE_NAMES.join(", ")}`;
  }
}

const CHUNK_SIZE = 1000;

const usd0 = new Intl.NumberFormat("en-US", {
  currency: "USD",
  maximumFractionDigits: 0,
  style: "currency",
});

const usd2 = new Intl.NumberFormat("en-US", {
  currency: "USD",
  maximumFractionDigits: 2,
  minimumFractionDigits: 2,
  style: "currency",
});

const syncCommand = Command.make(
  "sync",
  {
    dryRun: Flag.boolean("dry-run").pipe(
      Flag.withDescription("Aggregate locally but push nothing"),
    ),
    json: Flag.boolean("json").pipe(Flag.withDescription("Output machine-readable JSON")),
    since: Flag.string("since").pipe(
      Flag.optional,
      Flag.withDescription("Only sync days on or after this date (YYYY-MM-DD)"),
    ),
    sources: Flag.string("sources").pipe(
      Flag.optional,
      Flag.withDescription(
        `Comma-separated agents to sync (default: ${DEFAULT_SOURCE_NAMES.join(",")})`,
      ),
    ),
  },
  ({ dryRun, json, since, sources }) =>
    syncEffect({
      dryRun,
      json,
      since: Option.getOrUndefined(since),
      sources: Option.getOrUndefined(sources),
    }),
).pipe(Command.withDescription("Aggregate local agent usage via ccusage and push it"));

interface SyncOptions {
  dryRun: boolean;
  json: boolean;
  since?: string | undefined;
  sources?: string | undefined;
}

interface ResolveSyncAuthOptions {
  json: boolean;
}

type AuthenticatedCliConfig = CliConfig & { token: string };

interface SyncAuth {
  client: TokenmaxxingApiClient;
  config: AuthenticatedCliConfig;
  user: AuthUser;
}

function syncEffect(options: SyncOptions) {
  return Effect.gen(function* () {
    const console = yield* Effect.service(ConsoleService);

    const output = options.json ? { error: console.error, log: () => {} } : console;

    const requested = options.sources?.split(",") ?? DEFAULT_SOURCE_NAMES;
    const { invalid, sources } = resolveSources(requested);
    if (invalid.length > 0) {
      return yield* Effect.fail(new UnknownSourceError({ names: invalid }));
    }

    const auth = options.dryRun ? undefined : yield* resolveSyncAuth({ json: options.json });

    const rows: UsageDayInput[] = [];
    const sourceSummaries: Record<string, ReturnType<typeof summarize> | null> = {};
    for (const source of sources) {
      const report = yield* runCcusageSource(source, { since: options.since });
      if (Option.isNone(report) || report.value.length === 0) {
        sourceSummaries[source.source] = null;
        yield* Effect.sync(() => output.log(`${source.source.padEnd(9)} skipped (no data)`));
        continue;
      }

      const sourceRows = aggregateDays(source.source, report.value);
      const summary = summarize(sourceRows);
      sourceSummaries[source.source] = summary;
      rows.push(...sourceRows);
      yield* Effect.sync(() =>
        output.log(
          `${source.source.padEnd(9)} ${summary.days} days · ${summary.models} models · ${formatSyncUsd(summary.spendUsd)}`,
        ),
      );
    }

    if (options.dryRun || rows.length === 0) {
      yield* Effect.sync(() => {
        if (options.json) {
          console.log(
            JSON.stringify({
              dryRun: options.dryRun,
              rows: rows.length,
              sources: sourceSummaries,
              status: "ok",
            }),
          );
        } else {
          output.log(
            rows.length === 0
              ? "Nothing to sync."
              : `Dry run: ${rows.length} rows across ${sources.length} sources; nothing pushed.`,
          );
        }
      });
      return;
    }

    const device = { name: hostname(), platform: process.platform };
    let upserted = 0;
    if (auth === undefined) {
      return;
    }

    for (let offset = 0; offset < rows.length; offset += CHUNK_SIZE) {
      const chunk = rows.slice(offset, offset + CHUNK_SIZE);
      const response = yield* auth.client.usage
        .sync({ payload: { days: chunk, device } })
        .pipe(Effect.mapError((cause) => new SyncPushError({ cause })));
      upserted += response.upserted;
    }

    yield* Effect.sync(() => {
      if (options.json) {
        console.log(
          JSON.stringify({ rows: rows.length, sources: sourceSummaries, status: "ok", upserted }),
        );
      } else {
        const profileUrl = `${auth.config.wwwUrl}/${auth.user.login}`;
        output.log(`Synced ${rows.length} rows -> ${profileUrl}`);
      }
    });
  });
}

function resolveSyncAuth(options: ResolveSyncAuthOptions) {
  return Effect.gen(function* () {
    const config = yield* Effect.service(ConfigService);
    const clients = yield* Effect.service(ApiClientService);
    const console = yield* Effect.service(ConsoleService);

    const output = options.json ? { error: console.error, log: () => {} } : console;

    const stored = yield* config.readConfig();
    const envTokenActive = yield* config.hasEnvToken();
    if (stored.token === undefined) {
      if (options.json) {
        return yield* Effect.fail(new NotLoggedInError());
      }

      yield* Effect.sync(() => output.log("Not logged in; opening browser login."));
      return yield* loginForSync();
    }

    const authenticatedConfig: AuthenticatedCliConfig = { ...stored, token: stored.token };
    const client = yield* clients.make({
      baseUrl: authenticatedConfig.apiUrl,
      token: authenticatedConfig.token,
    });
    const validated = yield* client.me.me().pipe(
      Effect.map((me) => ({ _tag: "valid" as const, user: me.user })),
      Effect.catch((cause) => Effect.succeed({ _tag: "invalid" as const, cause })),
    );

    if (validated._tag === "valid") {
      return { client, config: authenticatedConfig, user: validated.user };
    }

    if (!isUnauthorizedError(validated.cause) || options.json || envTokenActive) {
      return yield* Effect.fail(new NotLoggedInError());
    }

    yield* config.clearToken();
    yield* Effect.sync(() => output.log("Stored token is no longer valid; opening browser login."));
    return yield* loginForSync();
  });
}

function loginForSync() {
  return Effect.gen(function* () {
    const clients = yield* Effect.service(ApiClientService);

    const login = yield* browserLoginEffect({ json: false });
    const token = login.config.token;
    const client = yield* clients.make({ baseUrl: login.config.apiUrl, token });

    return {
      client,
      config: { ...login.config, token },
      user: login.user,
    };
  });
}

function isUnauthorizedError(cause: unknown): boolean {
  return (
    typeof cause === "object" &&
    cause !== null &&
    (cause as { _tag?: string })._tag === "Unauthorized"
  );
}

function formatSyncUsd(value: number): string {
  return value >= 100 ? usd0.format(value) : usd2.format(value);
}

export {
  formatSyncUsd,
  resolveSyncAuth,
  syncCommand,
  syncEffect,
  SyncPushError,
  UnknownSourceError,
};

export type { ResolveSyncAuthOptions, SyncAuth, SyncOptions };
