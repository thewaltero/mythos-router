# AGENTS.md — mythos-router Project Standards

## Project Identity
- **Name**: mythos-router
- **Type**: CLI power tool (local-first, zero-slop)
- **Stack**: TypeScript on Node.js 20+ (ESM, `tsx` for dev)

## Architecture
- `src/cli.ts` — Commander.js entry point
- `src/config.ts` — Constants, system prompt, validation
- `src/client.ts` — Anthropic SDK wrapper (adaptive thinking)
- `src/swd.ts` — Strict Write Discipline engine
- `src/memory.ts` — Self-healing MEMORY.md manager
- `src/utils.ts` — Terminal colors, spinner, formatting
- `src/commands/chat.ts` — Interactive REPL
- `src/commands/verify.ts` — Codebase ↔ Memory drift scanner
- `src/commands/dream.ts` — Memory compression

## Conventions
1. **Zero external runtime deps** beyond `@anthropic-ai/sdk` and `commander`
2. **No `chalk`, no `ink`** — all terminal formatting is vanilla ANSI
3. **ESM only** — `"type": "module"` in package.json
4. All file operations use `node:fs` (sync) for SWD determinism
5. **SWD is non-negotiable** — every model output is verified against the filesystem
6. **MEMORY.md is sacred** — never delete it, only append or compress via Dream
7. The system prompt lives in `config.ts` — do NOT scatter prompt fragments

## File Operation Protocol
- Model must wrap file operations in `[FILE_ACTION: path]...[/FILE_ACTION]` blocks
- SWD parses these blocks and verifies against actual filesystem state
- Max 2 correction retries before yielding to human

## Running
```bash
# Dev mode (no build required)
npx tsx src/cli.ts chat
npx tsx src/cli.ts verify
npx tsx src/cli.ts dream

# Or via npm scripts
npm run chat
npm run verify
npm run dream
```
