# @851-labs/tokenmaxxing

CLI for [tokenmaxxing](https://tokenmaxxing.sh) — the social leaderboard
for LLM token usage. Parses your local agent usage (Claude Code, Codex,
OpenCode, Gemini CLI, Copilot CLI) via
[ccusage](https://github.com/ryoppippi/ccusage) and pushes daily aggregates
to your public profile.

## Usage

```bash
bunx @851-labs/tokenmaxxing@latest login   # sign in with GitHub, approves this device
bunx @851-labs/tokenmaxxing@latest sync    # parse local usage and push it
```

Always use `@latest` — bunx caches packages aggressively, and a stale CLI
can price usage with outdated rules.

Run `sync` as often as you like, from as many machines as you like —
profiles aggregate across devices. Useful flags: `--dry-run`,
`--since YYYY-MM-DD`, `--sources claude,codex`, `--json`.

### What gets uploaded (privacy)

Daily aggregates only: date, model name, agent name, token counts, and the
API-equivalent cost — never prompts, file paths, project names, or session
content. Revoke access anytime with `tokenmaxxing logout` or from
[settings](https://tokenmaxxing.sh/settings).

## License

MIT
