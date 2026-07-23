import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import type { D1Database, D1PreparedStatement, D1Result } from "@cloudflare/workers-types";
import { Effect, Layer } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Drizzle } from "../database";
import { UsageRepositoryLive } from "./d1";
import { RawUsageObjectStore } from "./raw-store";
import { UsageRepository } from "./service";
import type { UsageGithubDayInput } from "@tokenmaxxing/api-contract";

function run<A>(effect: Effect.Effect<A, any, any>): Promise<A> {
  return Effect.runPromise(effect as Effect.Effect<A, never, never>);
}

describe("usageGithubDays & presence repository handlers", () => {
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
      create table devices (
        id text primary key,
        user_id text not null,
        name text not null,
        platform text not null,
        arch text,
        version text,
        created_at integer not null,
        last_sync_at integer,
        last_check_in_at integer,
        service_auto_update_attempted_at integer,
        service_auto_update_completed_at integer,
        service_auto_update_current_version text,
        service_auto_update_enabled integer,
        service_auto_update_error text,
        service_auto_update_installed_version text,
        service_auto_update_latest_version text,
        service_auto_update_manager text,
        service_auto_update_reason text,
        service_auto_update_status text,
        service_backend text,
        service_error text,
        service_reload_required integer,
        service_repair_attempted_at integer,
        service_repair_completed_at integer,
        service_repair_error text,
        service_repair_reason text,
        service_repair_status text,
        service_runner_target text,
        service_runner_version text,
        service_scheduler_active integer,
        service_status text,
        service_template_version integer
      );
      create table usage_github_days (
        device_id text not null,
        user_id text not null,
        date text not null,
        push_count integer not null default 0,
        commit_count integer not null default 0,
        pr_count integer not null default 0,
        additions integer not null default 0,
        deletions integer not null default 0,
        synced_at integer not null,
        primary key (device_id, date)
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

  it("upserts GitHub days with monotone-max reconciliation", async () => {
    const repository = makeRepository();
    const now = new Date();
    const day1: UsageGithubDayInput = {
      additions: 100,
      commitCount: 5,
      date: "2026-07-23",
      deletions: 20,
      prCount: 1,
      pushCount: 5,
    };

    const res1 = await run(repository.upsertGithubDays("usr_1", "dev_1", [day1], now));
    expect(res1).toEqual({ upserted: 1 });

    const rows1 = sqlite.prepare("select * from usage_github_days").all() as Record<
      string,
      number
    >[];
    expect(rows1[0]!.commit_count).toBe(5);
    expect(rows1[0]!.additions).toBe(100);

    // Re-upsert larger metrics -> updates to higher values
    const day2: UsageGithubDayInput = {
      ...day1,
      additions: 150,
      commitCount: 8,
      deletions: 30,
    };

    await run(repository.upsertGithubDays("usr_1", "dev_1", [day2], now));
    const rows2 = sqlite.prepare("select * from usage_github_days").all() as Record<
      string,
      number
    >[];
    expect(rows2[0]!.additions).toBe(150);
  });

  it("computes device presence correctly based on check-in window", async () => {
    const repository = makeRepository();
    const now = Date.now();
    sqlite
      .prepare(
        "insert into users (id, login, name, created_at, updated_at) values ('usr_1', 'ritz', 'Ritz', ?, ?)",
      )
      .run(now, now);

    sqlite
      .prepare(
        "insert into devices (id, user_id, name, platform, created_at, last_check_in_at) values ('dev_active', 'usr_1', 'MacBook', 'darwin', ?, ?)",
      )
      .run(now, now - 2 * 60 * 1000); // 2 minutes ago (online)

    sqlite
      .prepare(
        "insert into devices (id, user_id, name, platform, created_at, last_check_in_at) values ('dev_offline', 'usr_1', 'PC', 'win32', ?, ?)",
      )
      .run(now, now - 30 * 60 * 1000); // 30 minutes ago (offline)

    const devices = await run(repository.getPresenceDevices("usr_1"));
    expect(devices).toHaveLength(2);

    const active = devices.find((d) => d.id === "dev_active");
    const offline = devices.find((d) => d.id === "dev_offline");

    expect(active?.isOnline).toBe(true);
    expect(offline?.isOnline).toBe(false);
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
