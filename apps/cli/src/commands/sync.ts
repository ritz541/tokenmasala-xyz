import { hostname } from "node:os";

import { Data, Effect, Option } from "effect";
import { Command, Flag } from "effect/unstable/cli";
import type { AuthUser, SourceUsageStatsInput, UsageDayInput } from "@tokenmaxxing/api-contract";

import { aggregateDays, summarize, type SourceSummary } from "../ccusage/aggregate";
import { runCcusageSessionCount, runCcusageSource } from "../ccusage/runner";
import { DEFAULT_SOURCE_NAMES, resolveSources } from "../ccusage/sources";
import {
  ApiClientService,
  BrowserService,
  type CliConfig,
  ConfigService,
  ConsoleService,
  TerminalService,
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

const integer = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 0,
});

const ANSI_STYLE_SEQUENCE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

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

type SyncSourceSummary = SourceSummary & { sessions: number | null };

interface SyncSourceResult {
  source: string;
  summary: SyncSourceSummary | null;
}

interface FormatOptions {
  env?: Record<string, string | undefined>;
}

type TableAlignment = "left" | "right";
type Style = (value: string) => string;

interface TableCell {
  align?: TableAlignment;
  style?: Style;
  value: string;
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
    const sourceSummaries: Record<string, SyncSourceSummary | null> = {};
    const sourceResults: SyncSourceResult[] = [];
    for (const source of sources) {
      yield* Effect.sync(() => output.log(`Scanning ${source.source}...`));
      const report = yield* runCcusageSource(source, { since: options.since });
      if (Option.isNone(report) || report.value.length === 0) {
        sourceSummaries[source.source] = null;
        sourceResults.push({ source: source.source, summary: null });
        continue;
      }

      const sourceRows = aggregateDays(source.source, report.value);
      const sessionCount = Option.match(
        yield* runCcusageSessionCount(source, { since: options.since }),
        {
          onNone: () => null,
          onSome: (count) => count,
        },
      );
      const summary = { ...summarize(sourceRows), sessions: sessionCount };
      sourceSummaries[source.source] = summary;
      sourceResults.push({ source: source.source, summary });
      rows.push(...sourceRows);
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
          output.log("");
          output.log(renderSyncTable(sourceResults));
          output.log("");
          output.log(rows.length === 0 ? "Nothing to sync." : "Dry run complete. Nothing pushed.");
        }
      });
      return;
    }

    const device = { name: hostname(), platform: process.platform };
    let upserted = 0;
    if (auth === undefined) {
      return;
    }
    const sourceStats = options.since === undefined ? sourceStatsForSync(sourceResults) : undefined;

    for (let offset = 0; offset < rows.length; offset += CHUNK_SIZE) {
      const chunk = rows.slice(offset, offset + CHUNK_SIZE);
      const response = yield* auth.client.usage
        .sync({
          payload: {
            days: chunk,
            device,
            ...(offset === 0 && sourceStats !== undefined ? { sourceStats } : {}),
          },
        })
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
        output.log("");
        output.log(renderSyncTable(sourceResults));
        output.log("");
        output.log(renderSyncSuccess(profileUrl));
      }
    });
    if (!options.json) {
      yield* openProfileIfAvailable(`${auth.config.wwwUrl}/${auth.user.login}`);
    }
  });
}

function sourceStatsForSync(
  results: readonly SyncSourceResult[],
): SourceUsageStatsInput[] | undefined {
  const stats = results.flatMap((result) =>
    result.summary?.sessions === undefined || result.summary.sessions === null
      ? []
      : [{ sessionCount: result.summary.sessions, source: result.source }],
  );

  return stats.length === 0 ? undefined : stats;
}

function openProfileIfAvailable(profileUrl: string) {
  return Effect.gen(function* () {
    const browser = yield* Effect.service(BrowserService);
    const console = yield* Effect.service(ConsoleService);
    const terminal = yield* Effect.service(TerminalService);

    if (!(yield* terminal.canOpenExternalBrowser)) {
      return;
    }

    const opened = yield* browser.open(profileUrl).pipe(
      Effect.match({
        onFailure: () => false,
        onSuccess: () => true,
      }),
    );

    if (!opened) {
      yield* Effect.sync(() =>
        console.error("Could not open profile automatically; open the URL above manually."),
      );
    }
  });
}

function renderSyncTable(
  results: readonly SyncSourceResult[],
  options: FormatOptions = {},
): string {
  const styles = makeStyles(options);
  const header: readonly TableCell[] = [
    { value: "Agent" },
    { value: "Status" },
    { align: "right", value: "Days" },
    { align: "right", value: "Sessions" },
    { align: "right", value: "Models" },
    { align: "right", value: "Spend" },
  ];
  const rows = results.map((result): readonly TableCell[] => {
    if (result.summary === null) {
      return [
        { value: result.source },
        { style: styles.skipped, value: "skipped" },
        { align: "right", style: styles.muted, value: "-" },
        { align: "right", style: styles.muted, value: "-" },
        { align: "right", style: styles.muted, value: "-" },
        { align: "right", style: styles.muted, value: "-" },
      ];
    }

    return [
      { value: result.source },
      { style: styles.synced, value: "synced" },
      { align: "right", value: formatInteger(result.summary.days) },
      {
        align: "right",
        style: result.summary.sessions === null ? styles.muted : undefined,
        value: result.summary.sessions === null ? "-" : formatInteger(result.summary.sessions),
      },
      { align: "right", value: formatInteger(result.summary.models) },
      { align: "right", value: formatSyncUsd(result.summary.spendUsd) },
    ];
  });

  return renderTable(header, rows, styles);
}

function renderSyncSuccess(profileUrl: string, options: FormatOptions = {}): string {
  const styles = makeStyles(options);

  return `${styles.synced("Sync complete.")}\nProfile: ${styles.link(profileUrl)}`;
}

function renderTable(
  header: readonly TableCell[],
  rows: readonly (readonly TableCell[])[],
  styles: ReturnType<typeof makeStyles>,
): string {
  const widths = header.map((cell, index) =>
    Math.max(
      visibleLength(cell.value),
      ...rows.map((row) => visibleLength(row[index]?.value ?? "")),
    ),
  );
  const renderRow = (row: readonly TableCell[], isHeader = false) =>
    row
      .map((cell, index) => {
        const padded = padCell(cell.value, widths[index] ?? 0, cell.align ?? "left");
        const style = isHeader ? styles.muted : cell.style;
        return style === undefined ? padded : style(padded);
      })
      .join("  ");

  return [renderRow(header, true), ...rows.map((row) => renderRow(row))].join("\n");
}

function padCell(value: string, width: number, align: TableAlignment): string {
  const padding = " ".repeat(Math.max(width - visibleLength(value), 0));
  return align === "right" ? `${padding}${value}` : `${value}${padding}`;
}

function visibleLength(value: string): number {
  return value.replaceAll(ANSI_STYLE_SEQUENCE, "").length;
}

function makeStyles(options: FormatOptions = {}): {
  link: Style;
  muted: Style;
  skipped: Style;
  synced: Style;
} {
  const env = options.env ?? process.env;
  const colors = !Object.prototype.hasOwnProperty.call(env, "NO_COLOR");

  return {
    link: (value) => (colors ? `\x1b[36;4m${value}\x1b[0m` : value),
    muted: (value) => (colors ? `\x1b[2m${value}\x1b[0m` : value),
    skipped: (value) => (colors ? `\x1b[33m${value}\x1b[0m` : value),
    synced: (value) => (colors ? `\x1b[32m${value}\x1b[0m` : value),
  };
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

      yield* Effect.sync(() => output.log("Not logged in; starting browser login."));
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
    yield* Effect.sync(() =>
      output.log("Stored token is no longer valid; starting browser login."),
    );
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

function formatInteger(value: number): string {
  return integer.format(value);
}

export {
  formatSyncUsd,
  openProfileIfAvailable,
  renderSyncSuccess,
  renderSyncTable,
  resolveSyncAuth,
  sourceStatsForSync,
  syncCommand,
  syncEffect,
  SyncPushError,
  UnknownSourceError,
};

export type { ResolveSyncAuthOptions, SyncAuth, SyncOptions };
