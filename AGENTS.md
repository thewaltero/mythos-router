# AGENTS.md — mythos-router Project Standards

## Project Identity
- **Name**: mythos-router
- **Type**: CLI power tool (local-first, zero-slop)
- **Stack**: TypeScript on Node.js 20+ (ESM, `tsx` for dev)

## Architecture
- `src/mcp-config.ts` — Paste-ready MCP client configuration helper
- `src/project-policy.ts` — Repo-local `.mythos/policy.json` loader and matcher
- `src/cli.ts` — Commander.js entry point
- `src/config.ts` — Constants, system prompt, validation, budget defaults
- `src/client.ts` — Provider facade and Anthropic direct-client compatibility path
- `src/budget.ts` — Session budget limiter (token cap, turn cap, progress bar)
- `src/swd.ts` — SWD execution kernel (engine, types, parsing, snapshots, verification, rollback)
- `src/swd-cli.ts` — SWD terminal presentation layer (verification output, dry-run preview)
- `src/sandbox.ts` — Isolated temp repo copy gate for external-agent checks before real writes
- `src/receipts.ts` — SWD trust receipts (creation, storage, drift verification)
- `src/memory.ts` — Self-healing MEMORY.md manager (SQLite FTS5 derivative index)
- `src/metrics.ts` — Global metrics store (persistent budget tracking)
- `src/diff.ts` — Myers' diff algorithm (zero-dependency, line-by-line)
- `src/git.ts` — Git operations (branching, committing, status)
- `src/mcp.ts` — MCP stdio adapter for SWD, receipts, and skills tools
- `src/utils.ts` — Terminal colors, spinner, formatting, badges, confirm prompt
- `src/index.ts` — Public SDK exports (SWDEngine, parseActions, etc.)
- `src/commands/chat.ts` — Interactive REPL and one-shot run orchestration (ChatSession + ChatUI abstraction)
- `src/commands/swd.ts` — Model-free external-agent SWD apply command (`mythos swd apply`)
- `src/commands/mcp.ts` — MCP stdio server command (`mythos mcp`)
- `src/commands/init.ts` — Project initialization (environment checks, provider detection, scaffolding)
- `src/commands/verify.ts` — Codebase ↔ Memory drift scanner (dry-run aware)
- `src/commands/receipts.ts` — SWD receipt list/show/verify command
- `src/commands/dream.ts` — Memory compression (dry-run aware)
- `src/commands/stats.ts` — Budget analytics reporter

## Conventions
1. **Zero external runtime deps** beyond `@anthropic-ai/sdk` and `commander`
2. **No `chalk`, no `ink`** — all terminal formatting is vanilla ANSI
3. **ESM only** — `"type": "module"` in package.json
4. All file operations use `node:fs` (sync) for SWD determinism
5. **SWD is non-negotiable** — every model or external-agent file action is verified against the filesystem
6. **MEMORY.md is sacred** — never delete it, only append or compress via Dream
7. The system prompt lives in `config.ts` — do NOT scatter prompt fragments
8. **Budget defaults live in `config.ts`** — 500K tokens, 25 turns, 80% warning
9. **Pricing constants live in `config.ts`** — update provider pricing there when model rates change
10. **Dry-run mode** — all filesystem writes must check `dryRun` flag before mutating

## File Operation Protocol
- Built-in model output and external agents must express file mutations as `[FILE_ACTION: path]...[/FILE_ACTION]` blocks or structured JSON actions.
- SWD parses these actions, validates paths, snapshots before/after state, verifies against actual filesystem state, and rolls back failed mutations when enabled.
- Max 2 correction retries before yielding to human in model-driven `chat`/`run` flows.
- In `--dry-run` mode, actions are previewed and must not mutate files or write receipts.

## External Agent SWD Protocol
- `.mythos/policy.json` is an enforced repo-local SWD policy. It can add blocks, confirmations, delete controls, operation allowlists, action batch limits, and write-size limits. Malformed policy files must fail closed.
- `mythos mcp config [generic|claude|cursor]` prints client config only. It must not start the MCP server, write files, call a model, or open a port.
- `mythos swd apply --stdin --json` is the model-free integration point for external/autonomous agents.
- `mythos swd apply --check <cmd>` applies approved actions inside an isolated temp repo copy, runs the trusted check command there, and only applies the same actions to the real working tree if every check passes.
- `mythos swd apply --run-checks` runs checks declared in `.mythos/policy.json` through the same isolated temp repo copy gate.
- `mythos mcp` exposes the same boundary to MCP-compatible clients over stdio; it must not start a daemon, open a port, or duplicate SWD logic.
- It must not require `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, or `DEEPSEEK_API_KEY`; the external agent brings its own model/key.
- MCP `swd_apply` may receive `check` commands or `runChecks: true`; these must reuse the same `applyExternalAgentActions` / sandbox path as the CLI.
- External SWD input must fail closed: reject oversized input, malformed JSON/actions, path traversal, sensitive paths, and high-impact command-surface changes unless explicitly allowed.
- Sensitive files such as `.env`, `.npmrc`, private keys, wallet files, and `.git` internals must remain blocked by default.
- Check commands are user-trusted shell commands, not an OS/container security sandbox. Never derive a check command from untrusted model output or arbitrary action content.
- Policy-declared checks must never run merely because a policy file exists; they require explicit `--run-checks` or MCP `runChecks: true`.
- `--dry-run` must never execute checks, mutate files, or write receipts.
- Receipts for external-agent applies should record the external agent/model identity without leaking secrets.

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
npx tsx src/cli.ts run "explain this repo architecture"
npx tsx src/cli.ts run --file TASK.md
npx tsx src/cli.ts run "fix the failing smoke test" --dry-run
your-agent --emit-file-actions | npx tsx src/cli.ts swd apply --stdin --json
your-agent --emit-file-actions | npx tsx src/cli.ts swd apply --stdin --json --check "npm test"
your-agent --emit-file-actions | npx tsx src/cli.ts swd apply --stdin --json --run-checks
npx tsx src/cli.ts mcp
npx tsx src/cli.ts verify
npx tsx src/cli.ts verify --dry-run
npx tsx src/cli.ts dream
npx tsx src/cli.ts dream --dry-run
npx tsx src/cli.ts stats
npx tsx src/cli.ts stats --days 7
npx tsx src/cli.ts receipts
npx tsx src/cli.ts receipts verify latest
npx tsx src/cli.ts init
npx tsx src/cli.ts init --check
npx tsx src/cli.ts init --force

# Or via npm scripts
npm run chat
npm run verify
npm run dream
npm run stats
npm run receipts
npm run mcp
npm run init
```
