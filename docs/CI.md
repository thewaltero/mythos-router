# Mythos CI Verification

`mythos verify --ci` brings Mythos verification into GitHub CI without calling a model.

It is read-only. It does not require an Anthropic key, does not use provider fallback, does not modify files, does not execute SWD actions, and does not write to `MEMORY.md`.

Use it to review PR diffs for high-impact repository changes before merge.

## What it checks

`verify --ci` reviews the current PR/diff for execution-surface and verification risks:

- `package.json` script changes and npm lifecycle hooks
- GitHub Actions workflow changes
- shell, deploy, Docker, and package-manager surfaces
- `.env`, `.npmrc`, private-key-like files, and high-confidence secrets
- changed Mythos receipts under `.mythos/receipts/`

If no Mythos receipt is present, the command still runs in generic PR-review mode.

If a Mythos receipt is changed in the PR, CI also checks receipt integrity and whether changed files are covered by the receipt.

## GitHub Actions setup

For normal users installing Mythos from npm, use `npx mythos-router`:

```yaml
name: Mythos Verify

on:
  pull_request:
  push:
  workflow_dispatch:

permissions:
  contents: read

jobs:
  mythos-verify:
    runs-on: ubuntu-latest

    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - uses: actions/setup-node@v4
        with:
          node-version: 22

      - name: Run Mythos CI verification
        run: npx mythos-router verify --ci
```

The explicit permissions block keeps the GitHub token read-only:

```yaml
permissions:
  contents: read
```

This is enough for Mythos CI Verification because the command only reads the repository diff and local files.


## Exit behavior

Default mode is intentionally review-friendly:

- `INFO` and `WARN` findings pass CI.
- `HIGH` findings fail CI.
- Runtime errors, such as running outside a git repository, exit with code `2`.

This means normal high-impact changes, such as editing a workflow file or adding a harmless package script, are reported for review but do not block CI by default.

Use strict mode if you want warnings to fail CI:

```bash
npx mythos-router verify --ci --strict
```

Use JSON output for downstream tooling:

```bash
npx mythos-router verify --ci --json
```

Compare against a specific base ref:

```bash
npx mythos-router verify --ci --base origin/main
```

## Example: warning that passes CI

```text
WARN package-json-scripts-changed package.json
  package.json scripts changed
  Evidence:
    - scripts.test changed
  Why: Package scripts can execute commands during test, build, install, publish, or CI workflows.
  Recommendation: Review script changes before merge and make sure they match the PR intent.
```

Warnings are review signals. They do not fail CI unless `--strict` is enabled.

## Example: high finding that fails CI

```text
HIGH npm-lifecycle-script-added package.json
  Npm install lifecycle script added
  Evidence:
    - scripts.postinstall added
  Why: Npm install lifecycle scripts can execute during dependency installation and are a common supply-chain review point.
  Recommendation: Avoid install lifecycle scripts unless absolutely necessary. If required, keep them minimal and review every command.
```

High findings fail CI by default.

## How this relates to Mythos Router

SWD verifies AI-assisted file changes locally.

`mythos verify --ci` brings that verification mindset into GitHub CI:

- changed files are reviewed before merge
- execution-surface changes are highlighted
- sensitive paths and high-confidence secrets are checked
- Mythos receipts are verified when present

Without receipts, it works as a generic PR-review check.

With receipts, it becomes Mythos-native CI verification for AI-assisted changes.
