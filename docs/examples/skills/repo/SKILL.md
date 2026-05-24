---
name: repo
version: 0.1.0
description: Repository operating rules for verified Mythos edits.
priority: 80
budget-multiplier: 1.0
allow-fallback: true
---

# repo Skill

## Purpose
Use this skill when Mythos is working inside a real project repository and must preserve the shape of the existing system.

## Read First
- README.md
- CHANGELOG.md
- package.json
- src/cli.ts
- src/commands/
- src/commands/swd.ts
- src/swd.ts
- src/security-policy.ts

## Rules
- Follow the current architecture and naming conventions before adding new patterns.
- Keep edits scoped to the requested behavior.
- Do not change public CLI flags, package scripts, CI, deploy files, or secret-handling files unless the task explicitly requires it.
- Prefer small, reviewable changes over broad refactors.
- Preserve dry-run behavior for every command that can write files.
- Treat `mythos swd apply` as the external-agent execution boundary: no model calls, fail-closed path checks, and JSON-safe output for automation.

## Verification
- If the task affects CLI behavior, suggest the narrowest command the maintainer should run.
- If the task affects external-agent SWD behavior, include `mythos swd apply --stdin --json` coverage or an equivalent test.
- If tests or builds cannot be run safely, state that clearly and name the exact check to run manually.
- Treat SWD receipts as the audit record for any successful filesystem mutation.

