# @tokenmasala/tokenmasala

CLI for [tokenmasala](https://tokenmasala.xyz) — the public leaderboard
for LLM token usage. Parses your local agent usage (Claude Code, Codex,
OpenCode, Gemini CLI, Copilot CLI, Pi, Amp, Droid, CodeBuff, Hermes,
Goose, OpenClaw, Kilo, Kimi, Qwen) via
[ccusage](https://github.com/ryoppippi/ccusage) and pushes daily aggregates
to your public profile.

## Usage

```bash
npm install -g @851-labs/tokenmaxxing@latest
tokenmaxxing login              # sign in in the browser, approves this device
tokenmaxxing sync               # parse local usage and push it
tokenmaxxing service install    # optional: sync automatically every 5 minutes
tokenmaxxing upgrade            # upgrade the global CLI and refresh the service
```

You can also install globally with `bun add -g --trust @851-labs/tokenmaxxing@latest`,
`pnpm add -g @851-labs/tokenmaxxing@latest`, or
`yarn global add @851-labs/tokenmaxxing@latest`.

> **Note:** The published npm package is still `@851-labs/tokenmaxxing` pending
> an npm scope rename to `@tokenmasala/tokenmasala`. The CLI binary is `tokenmaxxing`.

The background service uses the global `tokenmaxxing` binary and syncs every
5 minutes. It auto-updates through the package manager that installed the
global binary (bun, npm, pnpm, or yarn) when that package manager can be
detected.
Use `tokenmaxxing service status` for the last run and `tokenmaxxing service
doctor` to inspect scheduler files, auth, auto-update, locks, and recent logs.

Run `sync` as often as you like, from as many machines as you like —
profiles aggregate across devices. Useful flags: `--dry-run`,
`--since YYYY-MM-DD`, `--sources claude,codex`, `--json`.

### What gets uploaded (privacy)

Daily aggregates only: date, model name, agent name, token counts, and the
API-equivalent cost — never prompts, file paths, project names, or session
content. Revoke access anytime with `tokenmaxxing logout` or from
[settings](https://tokenmasala.xyz/settings).

## Supported agents

The CLI tracks 15 ccusage-compatible agents out of the box: `claude`, `codex`,
`opencode`, `gemini`, `copilot`, `pi`, `amp`, `droid`, `codebuff`, `hermes`,
`goose`, `openclaw`, `kilo`, `kimi`, `qwen`.

Harnesses without a parseable local transcript (hosted web chat, custom SDK
CLIs) are not captured by log-scan. Those gaps are tracked upstream in
[ccusage](https://github.com/ryoppippi/ccusage), not in this fork.

## License

MIT
