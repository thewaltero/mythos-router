# Contributing to mythos-router

Thanks for your interest in contributing! This guide covers both human and AI-assisted contributions.

---

## Getting Started

```bash
git clone https://github.com/thewaltero/mythos-router.git
cd mythos-router
npm install
cp .env.example .env
# Add your ANTHROPIC_API_KEY to .env
```

### Dev Mode (no build step)

```bash
npm run chat                  # interactive REPL
npm run verify                # codebase ↔ memory scan
npm run dream                 # compress memory
npx tsx src/cli.ts chat --dry-run --verbose   # full trace mode
```

### Build & Type Check

```bash
npm run build                 # tsc → dist/
npx tsc --noEmit              # type check only
```

---

## Project Conventions

Read [AGENTS.md](./AGENTS.md) before writing any code. The non-negotiable rules:

1. **Zero runtime dependencies** beyond `@anthropic-ai/sdk` and `commander`
2. **ESM only** — no `require()`, no CommonJS
3. **Vanilla ANSI** — no chalk, no ink, no color libraries
4. **All config in `src/config.ts`** — system prompt, budget defaults, pricing, model ID
5. **Dry-run safety** — every filesystem write must respect the `dryRun` flag

---

## Making Changes

### Before You Start

- Check existing [issues](https://github.com/thewaltero/mythos-router/issues) to avoid duplicate work
- For major changes, open an issue first to discuss the approach

### Pull Request Checklist

- [ ] Code compiles: `npx tsc --noEmit` passes
- [ ] Build succeeds: `npm run build` completes without errors
- [ ] No new runtime dependencies added
- [ ] SWD protocol preserved — file operations still go through `swd.ts`
- [ ] Dry-run mode tested if you touched any filesystem code
- [ ] `MEMORY.md` format preserved if you touched `memory.ts`

### Commit Style

Use clear, descriptive commit messages:

```
fix: correct budget overflow at exactly 100% threshold
feat: add --json flag for machine-readable verify output
refactor: extract snapshot logic from swd.ts into separate function
```

---

## AI-Assisted Contributions

mythos-router is an AI power tool, so AI-assisted contributions are welcome — but they must meet the same quality bar as human code.

### Requirements for AI-Generated PRs

1. **Type check must pass** — `npx tsc --noEmit` with zero errors
2. **Build must succeed** — `npm run build` clean
3. **No phantom dependencies** — AI agents love to `import` packages that aren't installed. Don't.
4. **No SWD bypass** — If your change touches file operations, it must go through the SWD pipeline
5. **Verify after changes** — Run `npm run verify` to confirm the codebase is consistent

### What Makes a Good AI-Assisted PR

- **Focused scope** — One logical change per PR, not a kitchen-sink refactor
- **Evidence of verification** — Show that you tested the change (terminal output, verify results)
- **Respect existing patterns** — Read `AGENTS.md` and match the code style already in use
- **No slop** — No placeholder comments, no `// TODO: implement later`, no half-finished code

### What Gets Rejected

- PRs that add runtime dependencies without a compelling reason
- PRs that scatter configuration across multiple files (config belongs in `config.ts`)
- PRs that bypass or weaken SWD verification
- PRs that modify `MEMORY.md` format without updating `memory.ts` to match
- Cosmetic-only PRs that churn code without functional improvement

---

## Project Structure

```
src/
├── cli.ts           # Commander.js entry point
├── config.ts        # All constants, system prompt, budget/pricing
├── client.ts        # Anthropic SDK wrapper
├── budget.ts        # Session budget limiter
├── swd.ts           # Strict Write Discipline engine
├── memory.ts        # MEMORY.md manager
├── utils.ts         # Terminal formatting (vanilla ANSI)
└── commands/
    ├── chat.ts      # Interactive REPL
    ├── verify.ts    # Codebase ↔ Memory drift scanner
    └── dream.ts     # Memory compression
```

---

## Questions?

Open an [issue](https://github.com/thewaltero/mythos-router/issues) or reach out on [X](https://x.com/thewaltero).
