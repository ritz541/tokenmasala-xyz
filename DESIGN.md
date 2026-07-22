# TokenMasala — public agent token + git leaderboard (fork design doc)

> **Name/domain:** `tokenmasala.xyz` (bought). Public dashboard (no auth gate for now).
> Privacy opt-in toggle is a deferred idea — kept in mind, not built yet. Product = a fork of
> `851-labs/tokenmaxxing` that tracks **every** agent harness a friend runs — not just the
> popular ones — plus GitHub pushes/LOC/commits, with a live, OpenRouter-dark dashboard.

---

## 0. Why this fork exists

Upstream tokenmaxxing is a social leaderboard for LLM token usage. It is MIT-licensed and
already does ~80% of what we want: multi-user profiles, public leaderboard, OAuth login,
Cloudflare Worker + D1 backend, TanStack Start dashboard, and an auto-syncing background
service. We are forking it, not building from scratch.

Three things upstream does **not** do, which this fork adds:

1. **Tracks every harness, including VS Code extensions and obscure ones** (grok, kimi-code,
   mimocode, qwen, mimo, cline, kiro, devin, agy, amp, cmd, poolside, agnes, pi, omp, zero,
   freebuff, vibe, Hermes, codex…). Upstream only parses ccusage-compatible local JSONL logs,
   which misses VS Code extensions and custom SDK scripts.
2. **Never lets the total go down.** Upstream recomputes daily totals from local logs and
   upserts last-write-wins — so clearing a cache _lowers_ the stored count. We make ingestion
   **append-only / additive**.
3. **Adds GitHub + live telemetry:** pushes, commits, LOC ±, and a real-time activity feed.

---

## 1. Locked decisions (discussed, agreed)

| Topic                        | Decision                                                                                                                                                                                                                                                                                   |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Privacy / deploy             | **Public** instance on Cloudflare (no auth gate for now). Privacy opt-in toggle is a deferred idea — kept in mind, not built yet.                                                                                                                                                          |
| Default tracking for friends | **Proxy-primary.** A local forwarder intercepts every API call (OpenAI/Anthropic-compatible) regardless of harness or editor, so VS Code extensions + obscure harnesses are caught automatically. **Log-parsing is a supplement** for accurate harness labels + one-time history backfill. |
| Live cadence                 | Default client batch-sync every 5 min. Proxy also streams each request to the API immediately → live meter is real-time when proxy active.                                                                                                                                                 |
| Live transport               | **SSE** for the activity feed (short-poll fallback). Scales fine to the 15–30 user target.                                                                                                                                                                                                 |
| Platforms                    | Linux (us + 1 friend) **and Windows** (most friends). Background sync must install a **Windows Task Scheduler** task, not only systemd.                                                                                                                                                    |
| Domain                       | `tokenburner.xyz` (placeholder; rename on purchase).                                                                                                                                                                                                                                       |

---

## 2. Architecture

```
┌─────────────┐   intercept   ┌────────────────┐   events    ┌──────────────┐
│ friend laptop│──API calls──▶│ local proxy     │─────────────▶│              │
│ (any harness,│              │ (forwarder+     │  UsageEvent  │  Cloudflare  │
│  VS Code ext)│──ccusage────▶│  logger)        │  (append)    │  Worker API  │
└─────────────┘   log parse   └────────────────┘             │  (D1 SQLite) │
                                                             │      │        │
                                                             │      ▼        │
                                                             │  dashboard   │
                                                             │  (TanStack,  │
                                                             │   Access-gated)│
└──────────────┘
        ▲
        │ GitHub push/commit/LOC via GitHub REST (OAuth token from login)
```

- **CLI (`apps/cli`)** gains: a proxy binary/mode, an event cursor, a Windows `schtasks`
  installer path, GitHub data collection (via the OAuth token already granted at login),
  and the domain baked into production defaults.
- **API (`apps/api`)** gains: an `ingestEvent` endpoint (append-only), a `syncGithub`
  endpoint, SSE activity endpoint, and the GitHub schema.
- **DB (`packages/db`)** gains: `usageEvents` (append-only source of truth) and
  `usageGithubDays`. `usageDays` is kept but becomes an _accumulated sum_ of events.
- **WWW (`apps/www`)** gains: dark OpenRouter-style theme, the full dashboard layout in §6,
  SSE live feed, Cloudflare Access compatibility (already works — it's just a host).

---

## 3. The append-only / additive model (fixes "count went down")

Upstream bug (confirmed in code): `syncBatch` upserts `usageDays` keyed by
`(deviceId, date, source, model)` **last-write-wins** (see `apps/api/src/usage/service.ts`
and `packages/api-contract/src/schemas.ts:111`). The CLI recomputes the day total from local
JSONL, so a cleared cache → smaller total → overwrite downward.

Fork fix:

- New table **`usageEvents`** = source of truth. One row per API response, carrying:
  `id, deviceId, userId, ts (ms), source, model, inputTokens, outputTokens,
cacheCreationTokens, cacheReadTokens, totalTokens, costUsd, createdAt`.
- The CLI tracks a **cursor** (last ingested event offset/timestamp). It sends **only new
  events** since the cursor — never a recomputed day total.
- Server **appends** events and **adds** their token/cost columns into the matching
  `usageDays` row (delta upsert), so `usageDays` stays correct for the existing leaderboard
  queries without rewriting every read path. Totals only ever increase.
- Deleting a local cache stops _new_ events for that window; recorded totals are untouched.
  History before install = one-time backfill, then frozen.

Harness attribution in proxy mode: detect from request endpoint/key
(`api.anthropic.com` → Claude-family, `api.openai.com`/OpenRouter → OpenAI-family, etc.) plus
a configurable `--label` friends can set. Log-parsing supplies the accurate label for
ccusage-compatible harnesses.

---

## 4. Data model additions (Drizzle, `packages/db/src/schema/index.ts`)

```ts
// Append-only source of truth. Never updated, only inserted.
const usageEvents = sqliteTable(
  "usage_events",
  {
    id: text("id").primaryKey(),
    deviceId: text("device_id").notNull(),
    userId: text("user_id").notNull(),
    ts: integer("ts", { mode: "timestamp_ms" }).notNull(),
    source: text("source").notNull(),
    model: text("model").notNull(),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    cacheCreationTokens: integer("cache_creation_tokens").notNull().default(0),
    cacheReadTokens: integer("cache_read_tokens").notNull().default(0),
    totalTokens: integer("total_tokens").notNull().default(0),
    costUsd: real("cost_usd").notNull().default(0),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [
    index("usage_events_user_ts_idx").on(t.userId, t.ts),
    index("usage_events_device_ts_idx").on(t.deviceId, t.ts),
  ],
);

// GitHub telemetry, one row per (device, date).
const usageGithubDays = sqliteTable(
  "usage_github_days",
  {
    deviceId: text("device_id").notNull(),
    userId: text("user_id").notNull(),
    date: text("date").notNull(),
    pushCount: integer("push_count").notNull().default(0),
    commitCount: integer("commit_count").notNull().default(0),
    prCount: integer("pr_count").notNull().default(0),
    additions: integer("additions").notNull().default(0),
    deletions: integer("deletions").notNull().default(0),
    costUsd: real("cost_usd").notNull().default(0), // agent spend that day (from usageEvents)
    syncedAt: integer("synced_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.deviceId, t.date] }),
    index("usage_github_days_user_idx").on(t.userId),
  ],
);
```

`usageDays` stays as-is in shape but is written by **addition** (delta upsert) in the new
ingest path.

---

## 5. API additions (`packages/api-contract/src/schemas.ts`, `apps/api/src`)

| Endpoint               | Purpose                                                                                      |
| ---------------------- | -------------------------------------------------------------------------------------------- |
| `POST /usage/events`   | Accept `UsageEventInput[]` (append-only), add deltas to `usageDays`.                         |
| `POST /github/sync`    | Accept `UsageGithubDayInput[]` (pushes/commits/LOC).                                         |
| `GET /activity/stream` | **SSE** of recent `usageEvents` (live feed). Query `?since=ts`.                              |
| `GET /activity`        | Short-poll fallback returning events since `ts`.                                             |
| `GET /presence`        | "Who's online" = devices with `lastCheckInAt` within N min (`devices` table already has it). |

`UsageEventInput` mirrors `usageEvents` minus server-set `id/userId/createdAt`, with
`onExcessProperty: "error"` like the other inputs.

---

## 6. Dashboard layout (OpenRouter-dark, Command-Code-clean)

Dark theme, dense, monospace numerals, subtle grid like OpenRouter. Gated by Cloudflare
Access (login wall is the Access policy, not app code).

**Global / home view**

1. **Top stat row:** tokens all-time · tokens today · $ burned today · how many online now.
2. **Rankings table:** rank · dev · tokens today · cache reads · output · model (top model
   badge). Sortable.
3. **Git block:** lines added · lines removed · commits · $ today (agent spend that day).
4. **Activity log (live):** streaming feed — each line: light-text cache-read count + model
   used + time. SSE-driven, newest on top.

**Dev profile view** (click a dev)

1. Today · output · est. cost · rank today.
2. **Graph: tokens per hour** (line/area).
3. Beside it: **last-hour tokens/min** small graph + **which harness used** (mini breakdown).
4. **Models table:** model · source · tokens · output · est. cost.
5. **Three telemetry graphs:** lines of code over time · commits over time · active time.

---

## 7. Windows + VS Code support

- Background sync (`tokenburner service install`) must branch on platform:
  - **Linux:** systemd user timer (existing) **+** the proxy as a systemd service.
  - **Windows:** `schtasks` to register a 5-min sync task **+** the proxy as a startup
    background process (or a scheduled task). No systemd on Windows.
- Proxy interception catches **Claude-in-VS-Code** and **OpenCode-in-VS-Code** because those
  extensions make real API calls that the proxy forwards — no extension-specific code needed.
- Install for a Windows friend: `npm i -g @<you>/tokenburner`, `tokenburner login`,
  `tokenburner service install`, and (optional) point their `OPENAI_BASE_URL` /
  `ANTHROPIC_BASE_URL` at the local proxy for full coverage.

---

## 8. Deploy + install runbook (target)

1. Fork repo → rename to `tokenmasala` → set domain in `apps/cli/src/services/config.ts`,
   `apps/api/src/config.ts`, `apps/api/src/worker.ts`, `alchemy.run.ts`, plus OAuth callback
   URLs (`.env.example` / `.env.production`).
2. Cloudflare: create D1 DB, set `CLOUDFLARE_API_TOKEN` + GitHub/Google OAuth secrets.
3. `bun run deploy` (Alchemy pushes Worker + D1 + migrations).
4. **Public:** no access gate for now — deploy the `www` app as-is so anyone with the URL can
   view the board. (Privacy opt-in toggle is a deferred, separate feature.)
5. Friend install: one-liner above. They `login` (OAuth), `service install` (schedules sync),
   optionally enable the proxy.

---

## 9. Build order (phases)

- **P0 — fork + repoint.** Clone (done), rename, bake domain, verify `bun run typecheck`
  (passing). Friends hit _our_ API, not upstream.
- **P1 — append-only events.** Add `usageEvents` schema + migration, `POST /usage/events`,
  CLI event cursor, delta upsert into `usageDays`. Proves the "count never goes down" fix.
- **P2 — proxy.** Local forwarder + `--label`; feed `usageEvents`. Cross-platform (Linux now,
  Windows scaffold).
- **P3 — GitHub + presence.** `usageGithubDays`, `POST /github/sync`, GitHub collection via
  OAuth token, `GET /presence`.
- **P4 — live feed.** SSE `GET /activity/stream` + short-poll fallback.
- **P5 — dashboard.** Dark theme + §6 layout (home + profile) reading the new endpoints.
- **P6 — Windows packaging.** `schtasks` installer path, test on a Windows friend.
- **P7 — deploy + Access gating + friend onboarding.**

---

## 10. Open items (not blocking P0/P1)

- Final domain purchase + repo rename.
- Confirm which harnesses each friend actually uses (scopes proxy label defaults).
- Whether to also expose a public "opt-in" leaderboard later (Access policy toggle).
