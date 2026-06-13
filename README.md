# tokenmaxxing

The social leaderboard for LLM token usage. Sync your local agent usage
(Claude Code, Codex, OpenCode, Gemini CLI, Copilot CLI), climb the board at
[tokenmaxxing.851.sh](https://tokenmaxxing.851.sh).

Built on [ccusage](https://github.com/ryoppippi/ccusage) for local usage
parsing, [Effect](https://effect.website) v4 end to end, and deployed to
Cloudflare (Workers + D1) with [Alchemy](https://alchemy.run) v2.

## Quick start

```bash
bunx @851-labs/tokenmaxxing@latest login   # sign in with GitHub, approves this device
bunx @851-labs/tokenmaxxing@latest sync    # parse local usage via ccusage and push it
```

Always use `@latest` — bunx caches packages aggressively, and a stale CLI
can price usage with outdated rules.

`sync` aggregates one row per (day × model × agent) and upserts — run it as
often as you like, from as many machines as you like; profiles aggregate
across all your devices. `--dry-run` shows what would be pushed, `--since
YYYY-MM-DD` bounds the range, `--sources claude,codex` picks agents.

### What gets uploaded (privacy)

Daily aggregates only: date, model name, agent name, token counts, and the
API-equivalent cost — never prompts, file paths, project names, or session
content. Profiles and the leaderboard are public; device hostnames appear
on your own settings page and in your per-device breakdown.

CLI tokens never expire. Revoke them with `tokenmaxxing logout` or from
[settings](https://tokenmaxxing.851.sh/settings).

## Layout

- `apps/api` — Effect HttpApi server on a Cloudflare Worker (D1)
- `apps/www` — TanStack Start site: leaderboard + profile dashboards
- `apps/cli` — `@851-labs/tokenmaxxing`, the `tokenmaxxing` CLI
- `packages/api-contract` — shared HttpApi contract (end-to-end types)
- `packages/db` — drizzle schema + D1 migrations

## Development

```bash
bun install
bun run dev        # alchemy dev: api :8788 + www :3002 on *.tokenmaxxing.localhost
bun run typecheck
bun run test
```

Copy `.env.example` to `.env` and fill in the GitHub OAuth pair (dev
callback `http://api.tokenmaxxing.localhost:8788/auth/github/callback`).
Run the CLI against the dev stack with
`TOKENMAXXING_ENV=development bun apps/cli/src/index.ts <command>`.

## Deploys

Every push to `main` deploys via GitHub Actions (typecheck + tests gate
it). Deploy state lives on a Cloudflare state-store worker
(`alchemy cloudflare bootstrap`), shared between CI and local machines —
`bun run deploy` does the same deploy locally, reading the prod OAuth pair
from `.env.production`. Required repo secrets: `CLOUDFLARE_API_TOKEN`,
`TMX_GITHUB_CLIENT_ID`, `TMX_GITHUB_CLIENT_SECRET`.

## License

MIT
