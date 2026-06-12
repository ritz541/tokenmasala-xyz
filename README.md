# tokenmaxxing

A social leaderboard for LLM token usage. Install the CLI, sync your local
agent usage (Claude Code, Codex, OpenCode, Gemini, Copilot, ...), and climb
the leaderboard at [tokenmaxxing.851.sh](https://tokenmaxxing.851.sh).

Built on [ccusage](https://github.com/ryoppippi/ccusage) for local usage
parsing.

## Layout

- `apps/api` — Effect HttpApi server on a Cloudflare Worker (D1)
- `apps/www` — TanStack Start site: leaderboard + profiles
- `apps/cli` — `@851-labs/tokenmaxxing`, the `tokenmaxxing` CLI
- `packages/api-contract` — shared HttpApi contract (end-to-end types)
- `packages/db` — drizzle schema + D1 migrations

## Development

```bash
bun install
bun run dev        # alchemy dev: api + www on *.tokenmaxxing.localhost
bun run typecheck
bun run test
```

Copy `.env.example` to `.env` and fill in the GitHub OAuth pair before
running the dev stack.

## License

MIT
