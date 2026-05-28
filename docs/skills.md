# Mythos Skills

Mythos skills are local `SKILL.md` rule packs. They let a repo or developer define the operating rules Mythos should follow before it edits files: architecture notes, files to read first, security boundaries, review expectations, and verification habits.

They are not runtime plugins and they do not execute code. A skill is plain Markdown with small YAML frontmatter, loaded into the system prompt when you pass `-s <name>`.

## Why Use Skills?

Good skills turn repeated project context into a reusable contract:

- Repo maintainers can commit `.mythos/skills/repo/SKILL.md` so every Mythos run follows the same project rules.
- Individual developers can keep global skills in `~/.mythos-router/skills/<name>/SKILL.md` for personal workflows across repos.
- Reviewers can inspect SWD receipts to see which skill id and version were active during a verified edit.

This is useful when the same rules matter across many tasks: public API stability, command-surface safety, security review, docs style, release discipline, or project-specific architecture.

## Resolution Order

For named skills, Mythos resolves in this order:

1. Project-local: `.mythos/skills/<name>/SKILL.md`
2. User-global: `~/.mythos-router/skills/<name>/SKILL.md`

Project skills intentionally win over global skills with the same name. A repo can therefore define its own `repo` skill without relying on every developer's home directory.

You can also pass an explicit file or directory path:

```bash
mythos run --file TASK.md -s ./docs/examples/skills/repo
mythos chat -s ./my-skill/SKILL.md
```

## Commands

```bash
mythos learn
mythos learn --dry-run
mythos skills
mythos skills new repo
mythos skills new security-review --global
mythos skills show repo
mythos skills check
mythos skills check repo
```

`mythos skills new <name>` creates a project-local skill by default. Use `--global` only for personal cross-repo skills.

`mythos learn` generates `.mythos/skills/repo/SKILL.md` from deterministic local repo signals. It looks at docs, package metadata, source directories, CI workflows, config files, tests, command surfaces, and security-sensitive paths. It does not call a model and it does not run project commands. Treat the output as a strong first draft that should be reviewed and edited by the maintainer.

The quality guard is simple: `learn` only writes rules derived from files it can see locally, validates the generated skill format before writing, refuses to overwrite an existing skill unless `--force` is passed, and supports `--dry-run` for review.

## Skill Format

```markdown
---
name: repo
version: 0.1.0
description: Project operating rules for verified Mythos runs.
priority: 70
budget-multiplier: 1.0
allow-fallback: true
---

# repo Skill

## Purpose
Explain the project context Mythos must understand before editing files.

## Read First
- package.json
- README.md
- src/cli.ts

## Rules
- Preserve public CLI behavior unless the task explicitly asks for a breaking change.
- Keep edits scoped to the requested behavior.
- Do not change CI, install, deploy, or secret-handling files unless the task requires it.

## Verification
- Prefer the narrowest relevant check.
- If a check cannot be run safely, say exactly what the human should run.
```

### Frontmatter

| Field | Required | Purpose |
|-------|----------|---------|
| `name` | recommended | Human-readable skill name shown in CLI output and receipts |
| `version` | recommended | Skill version recorded in receipts |
| `description` | recommended | Short description for `mythos skills` |
| `priority` | optional | Higher priority skills appear earlier in the active prompt |
| `budget-multiplier` | optional | Multiplies the session token cap for work that needs more context |
| `allow-fallback` | optional | Set `false` if the skill should disable provider fallback |
| `force-provider` | optional | Force a provider for this skill, if configured |
| `max-output-tokens` | optional | Cap output tokens for runs using this skill |
| `timeout-ms` | optional | Request timeout cap for runs using this skill |
| `requires-tools` | optional | Descriptive list of tool names the skill expects (shown in `mythos skills show`); informational only — it does not change model routing |
| `incompatible-with` | optional | Skill names or ids that should not be used together |

Example array fields:

```yaml
requires-tools:
  - filesystem
incompatible-with:
  - fast-docs
```

## Receipts

When a non-dry-run SWD operation writes a receipt, Mythos records the active skill ids, names, versions, and sources. Project-local skill paths are stored as project-relative paths. Global or outside-project paths are omitted from receipts to avoid leaking a user's home directory.

Use:

```bash
mythos receipts show latest
```

This gives reviewers a lightweight audit trail:

- What task was requested.
- What files SWD verified.
- Which provider/model ran.
- Which skill rule packs were active.
- Whether the current files still match the receipt.

## Recommended Patterns

Use a project `repo` skill for durable rules:

- important architecture files
- public API boundaries
- release/versioning expectations
- files Mythos should avoid unless asked
- preferred verification commands

Use global skills for reusable personal workflows:

- security review checklist
- docs editing style
- strict minimal-diff mode
- frontend accessibility review

Keep skills short and specific. A good skill feels like a senior maintainer leaving durable instructions, not a second README.

## Examples

Example skill files live in:

- `docs/examples/skills/repo/SKILL.md`
- `docs/examples/skills/security-review/SKILL.md`
