# STATUS — TokenMasala (tokenmasala.xyz)

> Living "where we are / what's next" doc. Read this first on any new session.
> Full product spec lives in `DESIGN.md`. Architecture/code lives in the repo.
> Last updated: 2026-07-23 (P2 proxy-complete).

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

## Why this fork exists (the one bug we must never regress)

Yesterday you cleared caches from many agent harnesses and your counted
token total **dropped**. Root cause: upstream `usageDays` is upserted by
`(deviceId, date, source, model)` **last-write-wins**, and the CLI recomputes
daily totals from local JSONL — so a smaller local cache overwrites the
stored (larger) total. **P1 fixes this** with an append-only event store +
server-authoritative watermark (see below).

## Build order & progress

| Phase | What | Status | Commit |
|-------|------|--------|--------|
| P0 | Repoint domain to tokenmasala.xyz + brand strings + DESIGN.md public | ✅ done | `94dac19` |
| P1 | Append-only `usageEvents` + server-authoritative watermark (counts never decrease) | ✅ done | `9183632` |
| P2 | Local proxy forwarder + `--label`; feeds `usageEvents`; Linux now, Windows scaffold | ✅ done | `a1f2c3d` |
| P3 | `usageGithubDays` + `POST /github/sync` + GitHub collection via OAuth token + `GET /presence` | ⬜ next |
| P4 | Live feed — SSE `GET /activity/stream` + short-poll fallback | ⬜ |
| P5 | Dashboard dark theme (OpenRouter density + commandcode cleanliness) + layout (home + profile drill-down) | ⬜ |
| P6 | Windows packaging — `schtasks` installer path; test on a Windows friend | ⬜ |
| P7 | Cloudflare deploy + friend onboarding | ⬜ |

## P1 architecture (the important part)

- **`usageEvents`** (append-only): one row per usage event, client-generated
  UUID `id`. Source of truth.
- **`deviceWatermarks`**: per `(deviceId, source)` the newest event `ts` the
  server has already counted.
- **`POST /usage/events`** (`IngestEventsInput` → `IngestEventsResponse`):
  reads watermark → **drops events with `ts <= watermark`** (a cleared local
  cache re-sending old events cannot subtract history) → inserts the rest →
  **additively** updates `usageDays` via
  `sql\`total_tokens + excluded.total_tokens\`` (totals only increase) → bumps
  watermark.
- Migration `packages/db/migrations/0012_*.sql` auto-applied at runtime by
  `Drizzle.layer` (no manual migrate step; just generate + commit).
- **Idempotency hardening (P2):** `insertEvents` now uses
  `.onConflictDoNothing({ target: usageEvents.id })` so a retried batch with
  the same client-generated `id` cannot double-count (the per-source watermark
  still guards against re-sent *older* events).

## P2 architecture (local proxy forwarder)

- **`tokenmaxxing proxy`** command (`apps/cli/src/commands/proxy.ts`): starts an
  HTTP server on `:8787` (override `--port`). Friends point their harness
  `OPENAI_BASE_URL` / `ANTHROPIC_BASE_URL` at `http://localhost:8787` and every
  API call is captured automatically — including VS Code extensions and obscure
  SDK harnesses the log scraper misses.
- **`apps/cli/src/proxy/`**:
  - `server.ts` — `node:http` forwarder; reads the full response (streaming +
    non-streaming), extracts usage, builds a `UsageEventInput`, buffers it, and
    flushes to `client.usage.events(...)` (the P1 `POST /usage/events`).
  - `usage.ts` — normalizes OpenAI + Anthropic usage shapes (handles SSE
    `usage` chunks, takes max-seen per field).
  - `router.ts` — resolves upstream base URL + provider family from
    `X-TM-Upstream` header → path prefix (`/openai`, `/anthropic`, `/v1/messages`)
    → `OPENAI_BASE_URL` / `ANTHROPIC_BASE_URL` env.
  - `pricing.ts` — compact per-model USD pricing table for `costUsd` estimates.
- **`--label`**: force a single harness source label for every event (e.g.
  `claude`, `my-vscode-ext`); without it, the source = inferred provider family.
- Features a `--no-flush` mode (buffer only) and `--json` for the background
  service. 22 unit + integration tests in `apps/cli/src/proxy/*.test.ts`.
- **Windows scaffold:** the proxy is plain `node:http` so it runs on Windows
  unchanged; wiring it into the `schtasks` service install lands in P6.

## Conventions / things already decided
  non-Windows users.
- **Harnesses to eventually track** (friends won't use all): hermes, pi, omp,
  cline, zero, freebuff, kiro-cli, devin, claude, agy, opencode, amp, cmd,
  poolside, agnes, kimi, qoder-cli, vibe, qwen, mimo, codex.
- **Dashboard**: dark, OpenRouter-style density + commandcode.ai cleanliness.
  Monochrome w/ single pink accent `#ff1493` (user rejected "AI slop" generic
  portfolio look). Profile drill-down: today's output, est. cost, rank,
  tokens/hour graph, last-hour tokens/min mini-graph w/ harness breakdown,
  models table (source, tokens, output, est. cost), + 3 telemetry graphs
  (LOC over time, commits over time, active time).
- **Live activity log**: shows cache reads, model, timestamp per event.

## Deferred decisions (need your input)

- **npm package scope**: still `@851-labs/tokenmaxxing`. The friend-install
  package needs YOUR npm org (e.g. `@tokenmasala/tokenmasala`). Tell me the
  org and I'll rename scope + `bootstrap`/`install` commands + publish workflow.
- **`851-labs` GitHub `sameAs` links** in `apps/www/src/lib/jsonld.ts` and
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
# CLI proxy tests only:
cd apps/cli && bunx vitest run src/proxy   # 22 tests, all pass
# API usage tests only:
cd apps/api && bunx vitest run src/usage   # 19 tests, all pass
```

## How to resume after a restart

1. `cd ~/Code/Projects/github/tokenmasala-xyz && git pull`
2. Read `STATUS.md` (this file) + `DESIGN.md`.
3. **P2 is done** — `tokenmaxxing proxy` (`:8787`) captures usage from any
   OpenAI/Anthropic call and flushes to `POST /usage/events`. Next phase is
   **P3**: `usageGithubDays` + `POST /github/sync` + GitHub collection via the
   OAuth token + `GET /presence`.
