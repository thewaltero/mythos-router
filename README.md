<div align="center">
<img src="assets/banner.png" alt="Mythos Router Banner" width="864" />

[![CodeQL](https://github.com/thewaltero/mythos-router/actions/workflows/github-code-scanning/codeql/badge.svg?branch=main)](https://github.com/thewaltero/mythos-router/actions/workflows/github-code-scanning/codeql)
[![npm](https://img.shields.io/npm/v/mythos-router?style=flat-square&color=cc785c)](https://www.npmjs.com/package/mythos-router)
[![Node.js](https://img.shields.io/badge/Node.js-20+-339933?style=flat-square&logo=node.js&logoColor=white)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-6.0-3178C6?style=flat-square&logo=typescript&logoColor=white)](https://typescriptlang.org)
[![Claude](https://img.shields.io/badge/Claude-Opus_4.7-cc785c?style=flat-square)](https://anthropic.com)
[![License](https://img.shields.io/badge/License-MIT-green?style=flat-square)](./LICENSE)
[![GitHub stars](https://img.shields.io/github/stars/thewaltero/mythos-router?style=social)](https://github.com/thewaltero/mythos-router)


## Claude Opus 4.7 · Strict Write Discipline · Zero Slop
**A local CLI power tool for verifiable AI-assisted coding.**

<br />

[What is this?](#what-is-this) • [Features](#features) • [Installation](#installation) • [Usage](#usage) • [Architecture](#architecture) • [Token Budget](#token-usage--budget) • [SDK](#-sdk-usage-for-agentic-systems) • [SWD Protocol](#the-swd-protocol)


---

### Support the project
**CA: `0xb942b75a602fa318ac091370d93d9143ba345ba3` ([$MYTHOS Token](https://app.uniswap.org/swap?outputCurrency=0xb942b75a602fa318ac091370d93d9143ba345ba3&chain=base))**

---


<p align="center">
  <img src="assets/demo.png" alt="mythos-router terminal demo" width="700" />
</p>

```bash
# Try it now
npx mythos-router chat
```

</div>

---

## What is this?

**mythos-router** is a local CLI power tool that wraps Claude Opus 4.7 with a custom verification protocol called **Strict Write Discipline (SWD)**.

Unlike standard Claude wrappers, mythos-router enforces filesystem verification: every file operation the AI claims to perform is *checked against the actual filesystem using SHA-256 snapshots*. If the model's claim doesn't match reality, it gets a Correction Turn. If it fails twice, it yields to the human.

Zero slop. Zero hallucinated state. Full adaptive thinking.

---

## Features

| Feature | Description |
|---------|-------------|
|  **mythos init** | Single-command project onboarding with environment validation, read-only `--check`, and scaffolding |
|  **mythos run** | One-shot prompt mode with inline, file, or stdin input: same SWD, budget, skills, branch, and optional test-healing pipeline as chat |
|  **Multi-Provider Fallback** | Auto-routes between Anthropic, DeepSeek, and OpenAI with circuit breakers |
|  **Verified Skill Packs** | Load project-local or user-global `SKILL.md` rules with `-s <name>`; active skills are recorded in SWD receipts |
|  **Deterministic Caching** | SQLite-backed caching for reasoning (SDK only) *(Node 22+)* |
|  **Adaptive Thinking** | Opus 4.7 with configurable effort levels (high/medium/low) |
|  **Strict Write Discipline** | Pre/post filesystem snapshots verify every model claim |
|  **SWD Receipts** | Per-run trust receipts record touched files, hashes, provider, budget, git state, and verification result |
|  **Self-Healing Memory** | Authority-based logging with a rebuildable SQLite FTS5 search index *(Node 22+)* |
|  **Auto-Healing TDD** | Pass `--test-cmd` for bounded, error-driven autonomous repair loops |
|  **Correction Turns** | Model gets 2 retries to match filesystem reality, then yields |
|  **Integrity Gate** | `verify` command ensures referenced memory files still exist |
|  **CI Verification** | `verify --ci` runs read-only PR checks for command-surface, sensitive-file, and receipt risks without an API key |
|  **Token Limiter** | Budget cap with graceful save — progress saved to MEMORY.md, never lose work |
|  **Session Resume** | Pick up exactly where you left off after a crash or exit (`--resume`) |
|  **Dry-Run Mode** | Preview every file operation before it executes — full transparency |
|  **Verbose Tracing** | See exactly what the AI is parsing, thinking, and verifying |
|  **Budget Analytics** | Persistent tracking of cost across sessions and projects via `stats` |
|  **Session Branching** | Isolate AI actions in a namespaced git branch (`mythos/`) |
|  **Zero Build** | Runs directly via `tsx` — no compile step in dev |

---

## Core Architectural Pillars

### 1. Configurable Model Selection
Choose the right model for the job via the `--effort` flag:

| Effort | Model | Best For |
|--------|-------|----------|
|  `high` (default) | Claude Opus 4.7 | Architecture, deep reasoning, complex refactors |
|  `medium` | Claude Sonnet 4.6 | Balanced code generation, everyday tasks |
|  `low` | Claude Haiku 4.5 | Quick answers, memory compression, verification |

The `dream` command automatically uses `low` effort (Haiku 4.5) for cost-efficient memory compression, and `verify` uses lightweight scanning — so you only burn Opus tokens when you need deep reasoning.

### 2. Authority-Based "Self-Healing" Memory
Most agentic systems stored state in opaque databases or messy JSON files. Mythos Router treats `MEMORY.md` as the **Sole Authority**. 

Every action is logged in Markdown first. On startup, the system verifies the integrity of the log via SHA-256 manifest hashing and reconstructs a high-performance **Derivative SQLite Index** (FTS5). If the index drifts or the database is deleted, the system self-heals by rebuilding from the authoritative Markdown source.

As memory approaches capacity, the `dream` command delegates a compression phase to a low-cost model (Haiku 4.5), ensuring your "Sacred Log" is always lean and relevant.

---

## Installation

> **Node.js Version Requirement:** The core CLI runs perfectly on **Node 20+**. However, the advanced SQLite-backed features (Telemetry Dashboard, Deterministic Caching, and High-Performance Memory Index) require **Node.js 22.5.0+**. If you run the tool on an older version, these features safely degrade with a warning without crashing the router.

### Quick Start (npm)

```bash
# Install globally
npm install -g mythos-router

# Set your API keys (Anthropic is primary, others are fallbacks)
export ANTHROPIC_API_KEY="sk-ant-..."
export OPENAI_API_KEY="sk-proj-..."
export DEEPSEEK_API_KEY="sk-..."

# Initialize and start
mythos init
mythos chat
```

### Or try without installing

```bash
npx mythos-router chat
```

### From Source

```bash
git clone https://github.com/thewaltero/mythos-router.git
cd mythos-router
npm install
npm run chat
```

---

## Usage

### `mythos init` — Project Onboarding

```bash
mythos init                  # Initialize mythos-router in the current project
mythos init --check          # Check environment and project setup without writing files
mythos init --force          # Re-scaffold files even if they already exist
```

`init` prepares the local repo surface Mythos uses: `.mythosignore`, `MEMORY.md`, and the project-local `.mythos/skills/` directory.

### `mythos skills` - Verified Skill Packs

```bash
mythos skills                # List project-local and user-global skills
mythos skills new repo       # Create .mythos/skills/repo/SKILL.md
mythos skills new audit --global  # Create ~/.mythos-router/skills/audit/SKILL.md
mythos skills show repo      # Inspect metadata and instructions
mythos skills check          # Validate all discovered skills
```

Skill packs are repo operating manuals for Mythos. They encode project conventions, files to read first, files to avoid, review expectations, and verification rules without adding runtime code. Project-local skills live in `.mythos/skills/<name>/SKILL.md` and win over global skills with the same name. User-global skills live in `~/.mythos-router/skills/<name>/SKILL.md` for personal reuse across repositories.

```bash
mythos run --file TASK.md -s repo
mythos chat -s repo -s security-review
```

When a non-dry-run SWD operation creates a receipt, Mythos records the active skill ids and versions. That makes skill-guided changes auditable: reviewers can see which repo rules were loaded when the verified edit happened. See [`docs/skills.md`](docs/skills.md) for the format and examples.

### `mythos run` — One-Shot Task

```bash
mythos run "explain this repo architecture"
mythos run --file TASK.md
cat TASK.md | mythos run --stdin
mythos run "update the docs for verify --ci" --dry-run
mythos run "fix the failing smoke test" --test-cmd "npm test"
mythos run "refactor provider scoring" --branch provider-score
```

`run` sends one prompt through the same Mythos pipeline as `chat`, including SWD verification, budget tracking, skills, branch sandboxing, receipts, and optional `--test-cmd` healing. The prompt can come from the command line, a local file, or piped stdin. It exits after that prompt instead of opening the interactive REPL, and it does not overwrite the resumable chat session used by `mythos chat --resume`.

### `mythos chat` — Interactive Session

```bash
mythos chat                  # Full power (high effort, Opus 4.7)
mythos chat -s repo          # Load a project-local skill pack
mythos chat --test-cmd "npm test" # Enable autonomous test-driven self-healing
mythos chat --effort low     # Budget mode (Haiku 4.5)
mythos chat --effort medium  # Balanced (Sonnet 4.6)
mythos chat --resume         # Resume your previous session exactly where you left off
mythos chat --dry-run        # Preview all file changes before executing
mythos chat --verbose        # See full SWD traces and thinking
mythos chat --branch refactor # Isolate session in a fresh git branch
mythos chat --dry-run --verbose  # Maximum transparency
```

####  Financial Safety — Budget Limiter

```bash
mythos chat                           # Default: 500K tokens, 25 turns
mythos chat --max-tokens 100000       # Cap at 100K tokens
mythos chat --max-turns 10            # Cap at 10 turns
mythos chat --max-tokens 50000 --max-turns 5  # Tight budget
mythos chat --no-budget               # Expert mode (no limits)
```

The budget limiter tracks every token, turn, and estimated cost in real-time:

```
budget: [████████░░░░░░░░░░░░] 78,342/500,000 tokens · [██████░░░░] 12/25 turns · ~$1.2340 · 4m 32s
```

At 80%, you get a yellow warning. At 100%, the session performs a **graceful save** — current progress is written to `MEMORY.md` so you can resume context in your next session. No work lost. Use `--no-budget` to disable (at your own risk). *Note: The limiter checks token usage between API calls, so a single large response may overshoot the configured limit.*

####  Dry-Run Mode — The Trust Builder

```bash
mythos chat --dry-run
```

In dry-run mode, every file operation is previewed before execution:

```
 DRY-RUN  ── File Action Preview ──
  2 file action(s) detected. Review each:

  1/2 MODIFY src/index.ts
  Description: Change 'axios' to 'fetch'
  Current state: 1,832 bytes, hash: 7a3f2c1e..
   DRY-RUN  Accept MODIFY on src/index.ts? [Y/n] y
  ✔ Accepted: MODIFY src/index.ts

  2/2 CREATE src/utils.ts
  Description: Add helper utilities
  Current state: does not exist
   DRY-RUN  Accept CREATE on src/utils.ts? [Y/n] n
  ⚠ Rejected: CREATE src/utils.ts
```

In-session commands:
- `/exit`, `/q` or `quit` — End session (shows final budget summary)

### `mythos receipts` — SWD Trust Receipts

```bash
mythos receipts              # List recent SWD receipts
mythos receipts show latest  # Inspect the newest receipt
mythos receipts verify latest  # Re-check current files against receipt hashes
mythos receipts --json       # Machine-readable output for tooling
```

Every non-dry-run SWD file operation writes a local receipt to `.mythos/receipts/`. Receipts include the user request summary, provider/model, token usage, budget snapshot, active skill packs, git branch/commit, per-file before/after hashes, rollback status, and optional `--test-cmd` result. `verify` turns those receipts into a quick drift check for "did the files still match what SWD verified?" Receipts are local by default and gitignored by default. They may include prompts, file paths, provider metadata, skill names, test command names, and a short test output tail. Do not publish raw receipts from private repositories; force-add only when you intentionally want a shared audit trail.

### `mythos verify` — Local Memory Scan + CI Verification

```bash
mythos verify              # Scan and log results to MEMORY.md
mythos verify --dry-run    # Scan without writing to MEMORY.md
mythos verify --ci         # Read-only PR/diff verification for GitHub CI
mythos verify --ci --json  # Machine-readable CI report
mythos verify --ci --strict # Fail CI on warnings as well as high findings
```

Local mode scans your project and cross-references against `MEMORY.md`:
- ✅ **Verified** — Memory logs are present and up to date
- ❌ **Missing** — Memory references a file that doesn't exist

CI mode does not call a model and does not require an API key. It reviews the current PR/diff for high-impact repo changes such as package scripts, npm lifecycle hooks, GitHub Actions workflows, shell/deploy surfaces, `.env`/`.npmrc`, high-confidence secrets, and changed Mythos receipts.

GitHub Actions example:

```yaml
name: Mythos Verify

on:
  pull_request:
  push:

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
      - run: npx mythos-router verify --ci
```

See [`docs/CI.md`](docs/CI.md) for exit behavior, strict mode, JSON output, and examples.

### `mythos dream` — Memory Compression

```bash
mythos dream              # Auto-compress when needed
mythos dream --force      # Force compression
mythos dream --dry-run    # Preview without writing
```

When `MEMORY.md` exceeds 100 entries, older logs are compressed into a summary block using Claude (low effort, minimal token burn). Recent entries are preserved intact.

### `mythos stats` — Budget Analytics & Cost Profiling

```bash
mythos stats              # Show all-time token usage and costs
mythos stats --days 7      # Filter for the last week
```

Tracks every penny spent across all your projects. Costs are aggregated by:
- **Command** (e.g., `chat` vs `dream`)
- **Project** (directory name)
- **Time Period**

Data is stored locally in `~/.mythos-router/metrics.json`.

### 🔌 SDK Usage (For Agentic Systems)

`mythos-router` exposes its Strict Write Discipline engine for programmatic use:

```typescript
import { SWDEngine, parseActions } from 'mythos-router';

// 1. Create an engine instance with your preferred options
const engine = new SWDEngine({
  strict: true,
  enableRollback: true,
  onAction: (action) => console.log(`Executing: ${action.operation} ${action.path}`),
  onVerify: (result) => console.log(`${result.status}: ${result.detail}`),
});

// 2. Let your agent generate code (must output [FILE_ACTION] blocks)
const agentOutput = await myAgent.generateCode();

// 3. Parse the agent's output and route through the SWD engine
const actions = parseActions(agentOutput);
const result = await engine.run(actions);

if (result.success) {
  console.log('✅ Agent execution verified securely');
} else {
  console.log('❌ Agent hallucinated a write. Rolled back:', result.rolledBack);
  console.log('Errors:', result.errors);
}
```


---

## Architecture

```
mythos-router/
├── src/
│   ├── cli.ts           # Commander.js entry point
│   ├── config.ts        # System prompt + constants + budget defaults + validation
│   ├── client.ts        # Anthropic SDK (adaptive thinking, streaming)
│   ├── budget.ts        # Session budget limiter (token cap, turn cap, progress bar)
│   ├── swd.ts           # SWD execution kernel (engine, types, parsing, snapshots)
│   ├── swd-cli.ts       # SWD terminal presentation (verification output, dry-run)
│   ├── receipts.ts      # SWD trust receipt creation, storage, and verification
│   ├── skills.ts        # Project-local and user-global SKILL.md packs
│   ├── ci/              # Read-only CI verification for PR/diff risk review
│   ├── memory.ts        # MEMORY.md self-healing manager (SQLite FTS5 index)
│   ├── metrics.ts       # Global metrics store (persistent budget tracking)
│   ├── diff.ts          # Myers' diff algorithm (zero-dependency)
│   ├── git.ts           # Git operations (branching, committing)
│   ├── utils.ts         # Terminal formatting, badges, prompts (zero-dep ANSI)
│   ├── index.ts         # Public SDK exports
│   └── commands/
│       ├── chat.ts      # Interactive REPL (ChatSession + ChatUI abstraction)
│       ├── init.ts      # Project onboarding and read-only setup checks
│       ├── verify.ts    # Codebase ↔ Memory scanner (dry-run aware)
│       ├── receipts.ts  # SWD receipt list/show/verify command
│       ├── skills.ts    # Skill pack list/show/new/check command
│       ├── dream.ts     # Memory compression (dry-run aware)
│       └── stats.ts     # Budget analytics reporter
├── src/providers/       # Multi-Provider Orchestration Engine
│   ├── orchestrator.ts  # Adaptive routing, circuit breakers, scoring
│   ├── pricing.ts       # Centralized token cost registry
│   ├── types.ts         # Unified BaseProvider contracts
│   ├── anthropic.ts     # Claude provider
│   └── openai.ts        # Fetch-based OpenAI & DeepSeek provider
├── test/                # Automated test suite (node:test)
├── .mythosignore        # SWD scan exclusions
├── MEMORY.md            # Auto-generated agentic memory
└── AGENTS.md            # Project conventions
```

## The SWD Protocol

```
User Input
    │
    ▼
[Claude Opus 4.7] ── adaptive thinking
    │
    ▼
[Parse FILE_ACTION blocks] ── extract claimed operations
    │
    ▼
[Snapshot referenced files] ── targeted filesystem state capture
    │
    ▼
[Verify] ── model claims vs. actual filesystem
    │
    ├── ✅ All verified → Log to MEMORY.md
    │
    └── ❌ Mismatch → Correction Turn (max 2 retries)
                │
                └── Still failing → Yield to human
```

---

## MEMORY.md — Should You Commit It?

**Yes.** `MEMORY.md` is designed to be committed to your repository. It becomes a "collaborative brain" where:
- Multiple developers can see what the AI did in previous sessions
- Different AI agents can reference past context
- You get a full audit trail of every AI-assisted file operation

If you prefer to keep it private, add `MEMORY.md` to your `.gitignore`.

---

## Configuration

| Env Variable | Required | Description |
|-------------|----------|-------------|
| `ANTHROPIC_API_KEY` | ✅ | Your Anthropic API key (Primary Provider) |
| `OPENAI_API_KEY` | ❌ | OpenAI API Key (Fallback Provider) |
| `DEEPSEEK_API_KEY` | ❌ | DeepSeek API Key (Fallback Provider, reasoning capable) |

| File | Purpose |
|------|---------| 
| `.mythosignore` | Patterns to exclude from SWD scanning |
| `.mythos/skills/` | Optional project-local skill packs that can be committed with a repo |
| `.mythos/receipts/` | Local SWD receipts, gitignored by default because they may include prompts and file paths |
| `MEMORY.md` | Auto-generated agentic memory log |
| `~/.mythos-router/skills/` | User-global skill packs available across projects |
| `~/.mythos-router/sessions/` | Resumable chat session state |

---

## Token Usage & Budget

### Opus 4.7 Pricing (as of 2026-05)

| Rate | USD |
|------|-----|
| Input tokens | $5.00 / 1M tokens |
| Output tokens | $25.00 / 1M tokens |

> ** Tokenizer Cost Inflation Alert**
> While the per-token price remains identical to Opus 4.6, **Opus 4.7 uses a new tokenizer that is significantly less efficient for Latin scripts**. 
> - English prompts require **~59% more tokens** (85 → 135 tokens per paragraph).
> - French requires **~34% more tokens**.
> - Mixed multilingual codebases effectively cost **~22% more**.
> - CJK languages (Chinese/Japanese/Korean) and code (Python) see smaller regressions (+4-21%).
> 
> *Bottom line: Expect your English-heavy mythos-router sessions to cost up to 59% more with Opus 4.7 than they did with 4.6, simply due to tokenizer changes.*

> Pricing constants live in `src/config.ts`. When Anthropic updates rates, change two lines — no budget math to refactor.

| Mode | Typical Cost Per Turn |
|------|----------------------|
| `--effort high` | Full Opus 4.7 pricing (deep reasoning) |
| `--effort medium` | Balanced — good for most tasks |
| `--effort low` | Minimal thinking — quick answers |
| `dream` | Low effort summarization (~500 tokens) |

| Budget Setting | Default |
|---------------|---------|
| `--max-tokens` | 500,000 per session |
| `--max-turns` | 25 per session |
| Warning threshold | 80% consumption |
| `--no-budget` | Disables all limits |

### Graceful Save

When the budget is reached, mythos doesn't just kill your session — it performs a **graceful save**:

```
⏸ BUDGET REACHED — Graceful Save
  498,231 tokens consumed across 25 turns (~$7.4200).
  Progress saved to MEMORY.md. Resume with mythos chat --resume to continue.
  Increase limits: mythos chat --max-tokens 1000000 --max-turns 50
  Disable limits:  mythos chat --no-budget
```

The system automatically saves your conversation history and budget state to `~/.mythos-router/sessions/latest.json`. You can instantly restore your exact context by running `mythos chat --resume`.

Token counts, estimated cost, and budget status are displayed after every chat response.

---

## Testing

```bash
npm test                 # Run full test suite
npx tsc --noEmit         # Type check only
npm run build            # Production build
```

---

## License

MIT

---

## Disclaimer

This project is an independent open-source tool built on top of the Anthropic API. It is not affiliated with or endorsed by Anthropic.

<div align="center"><sub>Built for structured AI agent workflows with verifiable execution.</sub></div>
