import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import type { D1Database, D1PreparedStatement, D1Result } from "@cloudflare/workers-types";
import { Effect, Layer } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Drizzle } from "../database";
import { UsageRepositoryLive } from "./d1";
import { RawUsageObjectStore } from "./raw-store";
import { UsageRepository } from "./service";

function run<A>(effect: Effect.Effect<A, any, any>): Promise<A> {
  return Effect.runPromise(effect as Effect.Effect<A, never, never>);
}

describe("getRecentEvents repository handler", () => {
  let sqlite: DatabaseSync;

  beforeEach(() => {
    sqlite = new DatabaseSync(":memory:");
    sqlite.exec(`
      create table users (
        id text primary key,
        login text not null,
        name text not null,
        avatar_url text,
        shadow_banned_at integer,
        shadow_banned_by_user_id text,
        created_at integer not null,
        updated_at integer not null
      );
      create table usage_events (
        id text primary key,
        device_id text not null,
        user_id text not null,
        ts integer not null,
        source text not null,
        model text not null,
        input_tokens integer not null default 0,
        output_tokens integer not null default 0,
        cache_creation_tokens integer not null default 0,
        cache_read_tokens integer not null default 0,
        total_tokens integer not null default 0,
        cost_usd real not null default 0,
        created_at integer not null
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

  it("fetches recent events joined with user profile metadata ordered by ts DESC", async () => {
    const repository = makeRepository();
    const now = Date.now();

    sqlite
      .prepare(
        "insert into users (id, login, name, avatar_url, created_at, updated_at) values ('usr_1', 'ritz', 'Ritz', 'https://avatar.example/ritz.png', ?, ?)",
      )
      .run(now, now);

    sqlite
      .prepare(
        "insert into usage_events (id, device_id, user_id, ts, source, model, input_tokens, output_tokens, cache_read_tokens, total_tokens, cost_usd, created_at) values ('evt_1', 'dev_1', 'usr_1', ?, 'claude', 'claude-3-5-sonnet', 1000, 200, 500, 1700, 0.05, ?)",
      )
      .run(now - 10000, now - 10000);

    sqlite
      .prepare(
        "insert into usage_events (id, device_id, user_id, ts, source, model, input_tokens, output_tokens, cache_read_tokens, total_tokens, cost_usd, created_at) values ('evt_2', 'dev_1', 'usr_1', ?, 'codex', 'gpt-5.3-codex', 2000, 300, 1000, 3300, 0.10, ?)",
      )
      .run(now, now);

    const events = await run(repository.getRecentEvents({ limit: 10 }));
    expect(events).toHaveLength(2);
    expect(events[0]!.user).toEqual({
      avatarUrl: "https://avatar.example/ritz.png",
      id: "usr_1",
      login: "ritz",
      name: "Ritz",
    });
    expect(events[0]!.model).toBe("gpt-5.3-codex");
    expect(events[1]!.id).toBe("evt_1");
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
