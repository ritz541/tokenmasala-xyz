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
    const r = sqlite
      .prepare("select * from usage_days")
      .all() as Array<Record<string, number | string>>;
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

    await run(
      repository.upsertChunk("user_1", "device_1", [base], new Date(1)),
    );
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

    await run(
      repository.upsertChunk("user_1", "device_1", [base], new Date(1)),
    );

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

    await run(
      repository.upsertChunk("user_1", "device_1", [base], new Date(1)),
    );
    await run(
      repository.upsertChunk("user_1", "device_1", [base], new Date(999)),
    );

    expect(row().total_tokens).toBe(1800);
    expect(row().synced_at).toBe(999); // metadata (syncedAt) still advances
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

function d1Statement(
  sqlite: DatabaseSync,
  query: string,
  parameters: SQLInputValue[] = [],
): D1PreparedStatement {
  return {
    all: async () => ({ results: sqlite.prepare(query).all(...parameters) }),
    bind: (...values: unknown[]) => d1Statement(sqlite, query, values as SQLInputValue[]),
    raw: async () => {
      const statement = sqlite.prepare(query);
      statement.setReturnArrays(true);
      return statement.all(...parameters);
    },
    run: async () => sqlite.prepare(query).run(...parameters),
  } as unknown as D1PreparedStatement;
}
