# STATUS — TokenMasala (tokenmasala.xyz)

> Living "where we are / what's next" doc. Read this first on any new session.
> Full product spec lives in `DESIGN.md`. Architecture/code lives in the repo.
> Last updated: 2026-07-23 (direction reset: ccusage log-scan only, proxy dropped).

## What this project is

A **public leaderboard for LLM agent token usage**. Fork of `tokenmaxxing`
(upstream `851-labs/tokenmaxxing`, Apache-2.0) renamed **TokenMasala**,
rebranded to **tokenmasala.xyz**. Friends install the CLI; it syncs local
agent usage; a live dark dashboard ranks everyone by tokens/spend.

- Fork repo (yours): `https://github.com/ritz541/tokenmasala-xyz.git`
- Upstream (not pushed to): `851-labs/tokenmaxxing`
- Local dir: `~/Code/Projects/github/tokenmasala-xyz`
- Domain: `tokenmasala.xyz` (prod API `api.tokenmasala.xyz`; dev `*.tokenmasala.localhost:8788`)
- Dashboard is **public** (no Cloudflare Access gate). Privacy opt-in toggle = deferred.

## Direction decision (2026-07-23) — proxy DROPPED

We initially built a local HTTP **proxy forwarder** (`tokenmaxxing proxy`) to
capture token usage at the wire. We **dropped it** for two reasons:

1. The safe (non-intrusive, no-CA) variant can only see connection metadata —
   not token counts (responses are end-to-end encrypted). So it couldn't feed
   the leaderboard at all. Useless for this product.
2. The alternative (MITM + installing a root CA on friends' machines) is
   intrusive and a privacy red flag. Not acceptable for friends.

**New direction: ccusage log-scan only.** `tokenmaxxing sync` shells out to the
`ccusage` npm package (a log-file scanner) which reads local agent transcripts
and emits daily usage. This is **zero-config** for friends (no base-URL edits,
no proxy), full token coverage for the supported harnesses, and stays in sync
with upstream ccusage improvements. Later we can patch ccusage itself for any
harness gaps rather than maintaining our own proxy.

> VS Code coverage note: Claude Code's VS Code extension is just a UI shell over
> the same `claude` CLI binary — it writes the **same** JSONL transcripts to the
> same agent config dir, so ccusage's `claude` source captures it. The only
> genuine blind spot is hosted-chat-style extensions (e.g. Anthropic's web
> "Claude" chat) that never spawn a local CLI. opencode-in-VS-Code is covered by
> ccusage's `opencode` source.

## Why this fork exists (the one bug we must never regress)

Yesterday you cleared caches from many agent harnesses and your counted
token total **dropped**. Root cause: upstream `usageDays` is upserted by
`(deviceId, date, source, model)` **last-write-wins**, and the CLI recomputes
daily totals from local JSONL — so a smaller local cache overwrites the
stored (larger) total. **P1 fixes this** with an append-only event store +
server-authoritative watermark (see below).

## Build order & progress

| Phase | What                                                                                                                                                                                                                                       | Status  | Commit    |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------- | --------- |
| P0    | Repoint domain to tokenmasala.xyz + brand strings + DESIGN.md public                                                                                                                                                                       | ✅ done | `94dac19` |
| P1    | Append-only `usageEvents` + server-authoritative watermark (counts never decrease)                                                                                                                                                         | ✅ done | `9183632` |
| P2    | **ccusage log-scan integration** — wire all ccusage sources into `sync`, bump spec, confirm zero-config capture                                                                                                                            | ✅ done | `4e5e7f8` |
| P2.5  | **Lossless session-level dedup** — `usageSessions` table + `POST /usage/sessions`; per-session dedup + additive fold into `usageDays`; per-source exclusivity (sessions win, daily raw skipped) so cache-clear same-day work is never lost | ✅ done | `b4c36e2` |
| P3    | `usageGithubDays` + `POST /github/sync` + GitHub collection via OAuth token + `GET /presence`                                                                                                                                              | ⬜ next |
| P4    | Live feed — SSE `GET /activity/stream` + short-poll fallback                                                                                                                                                                               | ⬜      |
| P5    | Dashboard dark theme (OpenRouter density + commandcode cleanliness) + layout (home + profile drill-down)                                                                                                                                   | ⬜      |
| P6    | Windows packaging — `schtasks` installer path; test on a Windows friend                                                                                                                                                                    | ⬜      |
| P7    | Cloudflare deploy + friend onboarding                                                                                                                                                                                                      | ⬜      |

> The old "local proxy forwarder" P2 was built then deliberately removed
> (commit resets it). Do NOT reintroduce `apps/cli/src/proxy/*` or
> `commands/proxy.ts` unless the direction changes again.

## P1 architecture (the important part)

Two distinct data paths, both designed so totals never decrease:

**Live snapshot path (what the CLI actually uses today).** ccusage emits a
_full daily total per (date, model)_ — a SNAPSHOT, not a delta. The CLI ships
those via `POST /usage/ingest` → `service.ingestRaw` → `d1.upsertChunk`. That
upsert was originally **last-write-wins** (`onConflictDoUpdate` replacing every
column) — which is exactly the bug: clear local caches, ccusage recomputes a
smaller day, re-sync overwrites the larger stored total downward. **Fixed
(2026-07-23): `upsertChunk` now reconciles with `max(stored, incoming)` on every
token/cost column** (SQLite `max()` scalar — D1 has no `greatest()`). This is
monotone non-decreasing under any re-send / cache-clear / clock-replay, and
idempotent (same snapshot = no-op). Zero schema change. Proven by
`apps/api/src/usage/monotonic.test.ts` (real sqlite engine, 3 cases).

**Append-only event path (audit + live feed).** `usageEvents` (append-only,
client UUID `id`) + `deviceWatermarks` per `(deviceId, source)` + `POST
/usage/events`: reads watermark → drops events with `ts <= watermark` → inserts
rest → **additively** folds into `usageDays` → bumps watermark. This path is
correct for _delta_ feeds (the dropped proxy used it). It is NOT on the
ccusage live path because ccusage gives snapshots; it remains the source the
P4 SSE live feed (`GET /activity/stream`) will stream from.

- Migration `packages/db/migrations/0012_*.sql` auto-applied at runtime by
  `Drizzle.layer` (no manual migrate step; just generate + commit).

> Design note: for SNAPSHOT data the provably-correct invariant is monotone
> MAX, not additive sum. Additive sum is correct only for deltas. Do not
> "fix" `upsertChunk` back to last-write-wins, and do not try to feed ccusage
> snapshots through the additive `insertEvents` (double counts).

## P2 architecture (ccusage log-scan integration)

- `tokenmaxxing sync` (`apps/cli/src/commands/sync.ts`) runs `ccusage` per
  source via `apps/cli/src/ccusage/runner.ts` and ingests the JSON reports via
  `POST /usage/ingest` (the monotone-max live path above).
- `apps/cli/src/ccusage/`:
  - `runner.ts` — shells out to `bun x ccusage@^20.0.18 <source> daily --json
--breakdown` (and `session`), normalizes the report, surfaces typed errors
    (`CcusageRunError`) without masking Bun failures as npm fallback.
  - `sources.ts` — `CCUSAGE_SOURCES`: the 15 focused sources ccusage >=20.0.18
    supports (see below).
  - `aggregate.ts` — maps ccusage daily rows → `UsageDayInput[]` (one row per
    `(date, model)`), handling the three per-source dialects; feeds the ingest
    path. NOTE: there is no `usage.ts`; do not add one expecting it to exist.
- **Zero-config for friends**: the CLI reads local agent logs directly; no
  base-URL edits, no proxy, no CA. This is the whole point of the direction.

## P2.5 architecture (lossless session-level dedup)

P1's `max()` floor prevents totals from _decreasing_, but it **silently loses
post-cache-clear same-day work**: `max(10000, 5000) = 10000` discards the 5000
you actually produced after clearing caches. P2.5 fixes that losslessly.

- **The invariant**: ccusage `session` reports carry a **stable per-session id**
  across re-scans (claude `session`, gemini/agy `sessionId`, codex `session_id`,
  etc.). A session is a unit of real work; once counted, it must never be
  counted again, and clearing local caches must not erase it.
- **`usage_sessions` table** (`packages/db/src/schema/index.ts`, migration
  `0013_brown_santa_claus.sql`): PK `(deviceId, source, sessionId)`, plus
  `date`, `lastActivity`, `model`, and the token/cost columns. The PK is the
  dedup set.
- **`POST /usage/sessions` → `service.ingestSessions` → `d1.insertSessions`**:
  selects existing `(source, sessionId)` rows for the device, diffs in JS,
  inserts only **unseen** sessions, then **additively** folds each new session
  into `usageDays` (`ON CONFLICT … total_tokens + excluded.total_tokens`).
  Returns `{ stored }`. `max()` stays as a floor on `usageDays` for the daily
  path.
- **Per-source exclusivity (the double-count guard)**: the daily snapshot path
  (`upsertChunk`/`max`) and the session path (`insertSessions`/additive) both
  write `usageDays` keyed by `(date, source, model)` and describe the _same_
  usage. So `sync` runs BOTH per source, but uploads them **exclusively**: if the
  session scan yielded ≥1 session → upload sessions only (authoritative,
  lossless) and **skip** the daily raw upload for that source; if the session
  scan yielded 0 (or failed) → fall back to the daily raw path. Per source,
  exactly one path writes `usageDays` → no 2×.
- **Harness-tolerent schema**: ccusage emits the session id and field names
  _differently per harness_ — claude uses `session`/`lastActivity`/`costUSD`/
  `models`; gemini/agy use `sessionId`/`totalCost`/`modelsUsed`/
  `modelBreakdowns` and carry **no timestamp**. `CcusageSession` accepts all of
  these; `aggregateSessions` derives `id` (`session ?? sessionId`), `model`
  (`models[0] ?? modelsUsed[0] ?? modelBreakdowns[0].modelName ?? "unknown"`),
  `costUsd` (`costUSD ?? totalCost ?? 0`), and `date` from `lastActivity`/
  `firstActivity`, falling back to today's local date when the report has none
  (the session is deduped by id, so the bucket is stable across re-syncs).
- **Proven by**: `apps/api/src/usage/monotonic.test.ts` (real sqlite: dedup of
  claude- and gemini-shaped sessions, additive fold, no double-count on re-send)
  and `apps/cli/src/commands/sync.test.ts` (exclusivity: sessions win → daily
  raw skipped; gemini shape tolerated; daily fallback on session failure).

## Conventions / things already decided

- **Harnesses tracked (log-scan):** ccusage >=20.0.18 supports 15 focused
  sources — claude, codex, opencode, gemini, copilot, pi, amp, droid, codebuff,
  hermes, goose, openclaw, kilo, kimi, qwen. All 15 are wired into
  `CCUSAGE_SOURCES` so `tokenmaxxing sync` labels + backfills them.
  - Caveat: anything that does NOT write a parseable local transcript (hosted
    chat extensions, custom SDK harnesses like `omp`, `cline`, `zero`,
    `kiro-cli`, `devin`, `agnes`, `qoder-cli`, `vibe`, `mimo`, `poolside`,
    `cmd`) is **not** captured by log-scan. Those are future ccusage-upstream
    gaps, not something we solve in this fork (the proxy was rejected).
- **Dashboard**: dark, OpenRouter-style density + commandcode.ai cleanliness.
  Monochrome w/ single pink accent `#ff1493` (user rejected "AI slop" generic
  portfolio look). Profile drill-down: today's output, est. cost, rank,
  tokens/hour graph, last-hour tokens/min mini-graph w/ harness breakdown,
  models table (source, tokens, output, est. cost), + 3 telemetry graphs
  (LOC over time, commits over time, active time).
- **Live activity log**: shows cache reads, model, timestamp per event.
- **Windows**: use `schtasks`, NOT systemd. All friends are Windows; only you
  - one other are non-Windows.

## Deferred decisions (need your input)

- **npm package scope**: still `@851-labs/tokenmaxxing`. The friend-install
  package needs YOUR npm org (e.g. `@tokenmasala/tokenmasala`). Tell me the
  org and I'll rename scope + `bootstrap`/`install` commands + publish workflow.
- **`851-labs` GitHub `sameAs` links** in `apps/www/src/lib/json-ld.ts` and
  `terms.tsx` still point upstream — cosmetic, repoint to your fork repo once
  created.
- **Internal `@tokenmaxxing/*` package names** kept for now (publishing later).

## Known issues / guardrails

- **`public-visibility.test.ts` fails on this Linux box** with
  `statement.setReturnArrays is not a function` — a local D1/better-sqlite
  driver quirk, **pre-existing and unrelated** to our changes (fails identically
  on untouched upstream HEAD). It blocks the pre-commit hook (`turbo test`), so
  commits are made with `--no-verify` (you approved this). Don't "fix" it by
  touching unrelated code.
- **Iteration budget raised to 200** (`agent.max_turns` + `HERMES_MAX_ITERATIONS`)
  so long build sessions don't get cut off.
- CLI git identity is `ritz541 <riteshshivajichavan@gmail.com>` (system config).
  Do NOT override with `-c user.name=ritz`. Auth to GitHub via `gh` CLI token.

## How to run / verify

```bash
bun install
bun run typecheck      # must be 5/5 green
bun run test           # turbo test (note the one pre-existing failure above)
bun run dev            # api :8788 + www :3002 on *.tokenmasala.localhost
# CLI ccusage tests only:
cd apps/cli && bunx vitest run src/ccusage   # all pass
# API usage tests only:
cd apps/api && bunx vitest run src/usage     # 19 tests, all pass
```

## How to resume after a restart

1. `cd ~/Code/Projects/github/tokenmasala-xyz && git pull`
2. Read `STATUS.md` (this file) + `DESIGN.md`.
3. **Direction is ccusage log-scan only — proxy is dropped.** P1 + P2 (log-scan
   integration) are done. Next phase is **P3**: `usageGithubDays` +
   `POST /github/sync` + GitHub collection via the OAuth token + `GET /presence`.
