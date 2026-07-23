import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { D1Database, D1PreparedStatement } from "@cloudflare/workers-types";
import { Effect, Layer } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Drizzle } from "../database";
import { UsageRepositoryLive } from "./d1";
import { RawUsageObjectStore } from "./raw-store";
import { UsageRepository } from "./service";
import type { UsageDayInput } from "@tokenmaxxing/api-contract";

function run<A>(effect: Effect.Effect<A, any, any>): Promise<A> {
  return Effect.runPromise(effect as Effect.Effect<A, never, never>);
}

/**
 * Proves the live sync path (`upsertChunk`) is monotone non-decreasing on
 * every token/cost column. ccusage sends full daily SNAPSHOTS, not deltas, so
 * a cache-clear + re-scan can re-send a smaller total; the store must keep the
 * higher value and never drop. Mirrors the real-DB harness in
 * public-visibility.test.ts.
 */
describe("usageDays monotonic reconciliation", () => {
  let sqlite: DatabaseSync;

  beforeEach(() => {
    sqlite = new DatabaseSync(":memory:");
    sqlite.exec(`
      create table usage_days (
        device_id text not null,
        user_id text not null,
        date text not null,
        source text not null,
        model text not null,
        input_tokens integer not null default 0,
        output_tokens integer not null default 0,
        cache_creation_tokens integer not null default 0,
        cache_read_tokens integer not null default 0,
        total_tokens integer not null default 0,
        cost_usd real not null default 0,
        synced_at integer not null,
        primary key (device_id, date, source, model)
      );
      create table usage_sessions (
        device_id text not null,
        source text not null,
        session_id text not null,
        user_id text not null,
        date text not null,
        last_activity integer not null,
        created_at integer not null,
        primary key (device_id, source, session_id)
      );
    `);
  });

  afterEach(() => sqlite.close());

  function makeRepository() {
    const drizzleLayer = Drizzle.layer({ raw: Effect.succeed(d1Database(sqlite)) });
    const rawStoreLayer = Layer.succeed(
      RawUsageObjectStore,
      RawUsageObjectStore.of({ putObject: () => Effect.void }),
    );
    return Effect.runSync(
      UsageRepository.pipe(
        Effect.provide(UsageRepositoryLive),
        Effect.provide(rawStoreLayer),
        Effect.provide(drizzleLayer),
      ),
    );
  }

  function row() {
    const r = sqlite.prepare("select * from usage_days").all() as Array<
      Record<string, number | string>
    >;
    expect(r).toHaveLength(1);
    return r[0]!;
  }

  const base: UsageDayInput = {
    cacheCreationTokens: 100,
    cacheReadTokens: 200,
    costUsd: 5,
    date: "2026-07-23",
    inputTokens: 1000,
    model: "gpt-5",
    outputTokens: 500,
    source: "codex",
    totalTokens: 1800,
  };

  it("keeps the larger total when a smaller re-scan is sent (cache clear)", async () => {
    const repository = makeRepository();

    await run(repository.upsertChunk("user_1", "device_1", [base], new Date(1)));
    expect(row().total_tokens).toBe(1800);

    // Local cache cleared; ccusage recomputes a smaller day total.
    await run(
      repository.upsertChunk(
        "user_1",
        "device_1",
        [{ ...base, inputTokens: 400, outputTokens: 200, totalTokens: 700, costUsd: 2 }],
        new Date(2),
      ),
    );

    // Stored total must NOT drop.
    expect(row().total_tokens).toBe(1800);
    expect(row().input_tokens).toBe(1000);
    expect(row().output_tokens).toBe(500);
    expect(row().cost_usd).toBe(5);
  });

  it("absorbs a genuine increase on the next scan (new usage)", async () => {
    const repository = makeRepository();

    await run(repository.upsertChunk("user_1", "device_1", [base], new Date(1)));

    await run(
      repository.upsertChunk(
        "user_1",
        "device_1",
        [{ ...base, inputTokens: 1500, outputTokens: 800, totalTokens: 2600, costUsd: 8 }],
        new Date(2),
      ),
    );

    expect(row().total_tokens).toBe(2600);
    expect(row().input_tokens).toBe(1500);
    expect(row().output_tokens).toBe(800);
    expect(row().cost_usd).toBe(8);
  });

  it("is idempotent: re-sending the same snapshot is a no-op", async () => {
    const repository = makeRepository();

    await run(repository.upsertChunk("user_1", "device_1", [base], new Date(1)));
    await run(repository.upsertChunk("user_1", "device_1", [base], new Date(999)));

    expect(row().total_tokens).toBe(1800);
    expect(row().synced_at).toBe(999); // metadata (syncedAt) still advances
  });

  it("deduplicates session IDs and additively folds fresh sessions into usageDays", async () => {
    const repository = makeRepository();
    const now = new Date();

    const session1 = {
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      costUsd: 1.0,
      date: "2026-07-23",
      inputTokens: 1000,
      lastActivity: Date.now(),
      model: "claude-3-5-sonnet",
      outputTokens: 500,
      sessionId: "sess_001",
      source: "claude",
      totalTokens: 1500,
    };

    // First ingestion of sess_001
    const res1 = await run(repository.insertSessions("usr_1", "dev_1", [session1], now));
    expect(res1).toEqual({ stored: 1 });
    expect(row().total_tokens).toBe(1500);

    // Re-ingest same sess_001 -> stored: 0, total_tokens stays 1500
    const res2 = await run(repository.insertSessions("usr_1", "dev_1", [session1], now));
    expect(res2).toEqual({ stored: 0 });
    expect(row().total_tokens).toBe(1500);

    // New fresh session sess_002 after a local cache clear
    const session2 = {
      ...session1,
      sessionId: "sess_002",
      totalTokens: 2000,
      inputTokens: 1500,
      outputTokens: 500,
    };

    const res3 = await run(repository.insertSessions("usr_1", "dev_1", [session2], now));
    expect(res3).toEqual({ stored: 1 });
    // Total tokens additively folded: 1500 + 2000 = 3500!
    expect(row().total_tokens).toBe(3500);
  });

  it("deduplicates gemini/agy-shaped sessions (sessionId, no timestamp)", async () => {
    const repository = makeRepository();
    const now = new Date();

    // Real ccusage gemini output uses `sessionId` (not `session`) and carries
    // no lastActivity; the CLI maps totalCost->costUsd and falls back to date.
    const geminiSession = {
      cacheCreationTokens: 0,
      cacheReadTokens: 19444,
      costUsd: 0.0028967,
      date: "2026-07-23",
      inputTokens: 303,
      lastActivity: Date.now(),
      model: "gemini-3-flash-preview",
      outputTokens: 47,
      sessionId: "89f4d4c7-44ec-499f-9ffc-348216b85a74",
      source: "gemini",
      totalTokens: 20338,
    };

    const res1 = await run(repository.insertSessions("usr_1", "dev_1", [geminiSession], now));
    expect(res1).toEqual({ stored: 1 });
    expect(row().total_tokens).toBe(20338);

    // Re-send the same gemini session: deduped, total unchanged (no double count).
    const res2 = await run(repository.insertSessions("usr_1", "dev_1", [geminiSession], now));
    expect(res2).toEqual({ stored: 0 });
    expect(row().total_tokens).toBe(20338);
  });
});

function d1Database(sqlite: DatabaseSync): D1Database {
  return {
    batch: async (statements: Array<{ run: () => Promise<unknown> }>) => {
      const results = [];
      for (const statement of statements) {
        results.push(await statement.run());
      }
      return results as unknown as D1Result<unknown>[];
    },
    prepare: (query: string) => d1Statement(sqlite, query),
  } as unknown as D1Database;
}
/** Positional-array raw() that handles duplicate column names across joins. */
function d1Raw(sqlite: DatabaseSync, query: string, parameters: SQLInputValue[]): unknown[][] {
  const stmt = sqlite.prepare(query);
  const cols = stmt.columns();
  const seen = new Set<string>();
  const hasDupes = cols.some((c) => {
    if (seen.has(c.name)) return true;
    seen.add(c.name);
    return false;
  });
  if (!hasDupes) {
    return (stmt.all(...parameters) as Record<string, unknown>[]).map((r) => Object.values(r));
  }
  const fromIdx = query.toLowerCase().indexOf(" from ");
  const selectPart = query.substring(7, fromIdx);
  const colExprs = selectPart.split(",").map((s) => s.trim());
  const aliased = colExprs.map((expr, i) => `${expr} as "__c${i}"`);
  const newQuery = `select ${aliased.join(", ")}${query.substring(fromIdx)}`;
  const rows = sqlite.prepare(newQuery).all(...parameters) as Record<string, unknown>[];
  return rows.map((r) => cols.map((_, i) => r[`__c${i}`]));
}

function d1Statement(
  sqlite: DatabaseSync,
  query: string,
  parameters: SQLInputValue[] = [],
): D1PreparedStatement {
  return {
    all: async () => ({ results: sqlite.prepare(query).all(...parameters) }),
    bind: (...values: unknown[]) => d1Statement(sqlite, query, values as SQLInputValue[]),
    raw: async () => d1Raw(sqlite, query, parameters),
    run: async () => sqlite.prepare(query).run(...parameters),
  } as unknown as D1PreparedStatement;
}
