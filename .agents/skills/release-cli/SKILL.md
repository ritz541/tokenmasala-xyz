---
name: release-cli
description: Release a new version of the tokenmaxxing CLI to npm. Use when explicitly asked to release or publish @851-labs/tokenmaxxing, including checking main, bumping apps/cli/package.json, committing, tagging cli-vX.Y.Z, pushing, monitoring the Release CLI workflow, and smoke testing the published package.
---

# CLI Release Process

Follow these steps to release a new version of the `@851-labs/tokenmaxxing` CLI. Only perform mutating release actions when the user explicitly asks to release or publish a new CLI version.

## Pre-flight Checks

Verify `main` is clean and current.

```sh
git status --short --branch
git branch --show-current
git pull origin main
```

If the working tree has unrelated changes, stop and ask before staging or committing.

## Step 1: Choose And Bump Version

Decide the bump from the requested change scope: `patch`, `minor`, `major`, or a prerelease variant when explicitly requested.

Update only `apps/cli/package.json` for the new version unless the lockfile changes after install.

```sh
$EDITOR apps/cli/package.json
bun install --lockfile-only
node -p "JSON.parse(require('node:fs').readFileSync('apps/cli/package.json', 'utf8')).version"
```

Use the printed version as `X.Y.Z` below.

## Step 2: Run Checks

Run the existing checks directly.

```sh
bun --filter @851-labs/tokenmaxxing typecheck
bun --filter @851-labs/tokenmaxxing test
bun run lint
bun run fmt
bun --filter @851-labs/tokenmaxxing build
```

Fix failures before continuing.

## Step 3: Commit Version Bump

Stage only the release files.

```sh
git add apps/cli/package.json bun.lock
git commit -m "chore: release cli vX.Y.Z"
```

If `bun.lock` did not change, omit it from `git add`.

## Step 4: Create And Push Tag

```sh
git tag cli-vX.Y.Z
git push origin main
git push origin cli-vX.Y.Z
```

The `cli-vX.Y.Z` tag starts the `Release CLI` GitHub Actions workflow.

## Step 5: Monitor Publish Workflow

Wait for the workflow run to appear and watch it.

```sh
gh run list --workflow "Release CLI" --limit 1
gh run watch
```

If no run appears yet, wait and retry.

```sh
sleep 10
gh run list --workflow "Release CLI" --limit 1
```

If the workflow fails, inspect logs.

```sh
gh run view --log-failed
```

## Step 6: Smoke Test Published Package

Use `npx` for exact-version install resolution, then confirm npm latest.

```sh
npx @851-labs/tokenmaxxing@X.Y.Z --help
bun pm view @851-labs/tokenmaxxing version
```

Confirm `bun pm view` returns `X.Y.Z`.

## Troubleshooting

### Checks Fail

Fix failing checks before releasing.

### Tag Already Exists

Delete the local and remote tag, then retry.

```sh
git tag -d cli-vX.Y.Z
git push origin :refs/tags/cli-vX.Y.Z
```

### Push Rejected

Pull latest and retry.

```sh
git pull --rebase origin main
```

### Publish Workflow Fails After Tag Push

Fix the failure on `main`, delete the failed tag locally and remotely, then create a new tag from the corrected commit.
