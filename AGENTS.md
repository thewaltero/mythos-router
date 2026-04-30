# AGENTS.md — mythos-router Project Standards

## Project Identity
- **Name**: mythos-router
- **Type**: CLI power tool (local-first, zero-slop)
- **Stack**: TypeScript on Node.js 20+ (ESM, `tsx` for dev)

## Architecture
- `src/cli.ts` — Commander.js entry point
- `src/config.ts` — Constants, system prompt, validation, budget defaults
- `src/client.ts` — Anthropic SDK wrapper (adaptive thinking, streaming)
- `src/budget.ts` — Session budget limiter (token cap, turn cap, progress bar)
- `src/swd.ts` — SWD execution kernel (engine, types, parsing, snapshots — pure, no I/O)
- `src/swd-cli.ts` — SWD terminal presentation layer (verification output, dry-run preview)
- `src/memory.ts` — Self-healing MEMORY.md manager (SQLite FTS5 derivative index)
- `src/metrics.ts` — Global metrics store (persistent budget tracking)
- `src/diff.ts` — Myers' diff algorithm (zero-dependency, line-by-line)
- `src/git.ts` — Git operations (branching, committing, status)
- `src/utils.ts` — Terminal colors, spinner, formatting, badges, confirm prompt
- `src/index.ts` — Public SDK exports (SWDEngine, parseActions, etc.)
- `src/commands/chat.ts` — Interactive REPL (ChatSession orchestrator + ChatUI abstraction)
- `src/commands/init.ts` — Project initialization (environment checks, provider detection, scaffolding)
- `src/commands/verify.ts` — Codebase ↔ Memory drift scanner (dry-run aware)
- `src/commands/dream.ts` — Memory compression (dry-run aware)
- `src/commands/stats.ts` — Budget analytics reporter

## Conventions
1. **Zero external runtime deps** beyond `@anthropic-ai/sdk` and `commander`
2. **No `chalk`, no `ink`** — all terminal formatting is vanilla ANSI
3. **ESM only** — `"type": "module"` in package.json
4. All file operations use `node:fs` (sync) for SWD determinism
5. **SWD is non-negotiable** — every model output is verified against the filesystem
6. **MEMORY.md is sacred** — never delete it, only append or compress via Dream
7. The system prompt lives in `config.ts` — do NOT scatter prompt fragments
8. **Budget defaults live in `config.ts`** — 500K tokens, 25 turns, 80% warning
9. **Pricing constants live in `config.ts`** — update `COST_PER_INPUT_TOKEN` / `COST_PER_OUTPUT_TOKEN` when Anthropic changes rates
10. **Dry-run mode** — all filesystem writes must check `dryRun` flag before mutating

## File Operation Protocol
- Model must wrap file operations in `[FILE_ACTION: path]...[/FILE_ACTION]` blocks
- SWD parses these blocks and verifies against actual filesystem state
- Max 2 correction retries before yielding to human
- In `--dry-run` mode, actions are previewed with `[Y/n]` prompts instead of verified

## Budget Limiter Protocol
- `SessionBudget` tracks tokens + turns + estimated cost per session (not persisted across runs)
- Pre-check before every API call — **graceful save** at limit (progress → MEMORY.md)
- Warning at 80% consumption
- `--no-budget` disables for expert users
- Correction turns count toward the budget

## Running
```bash
# Dev mode (no build required)
npx tsx src/cli.ts chat
npx tsx src/cli.ts chat --dry-run --verbose
npx tsx src/cli.ts chat --max-tokens 100000 --max-turns 10
npx tsx src/cli.ts chat --no-budget
npx tsx src/cli.ts verify
npx tsx src/cli.ts verify --dry-run
npx tsx src/cli.ts dream
npx tsx src/cli.ts dream --dry-run
npx tsx src/cli.ts stats
npx tsx src/cli.ts stats --days 7
npx tsx src/cli.ts init
npx tsx src/cli.ts init --force

# Or via npm scripts
npm run chat
npm run verify
npm run dream
npm run stats
npm run init
```
