<div align="center">

```
    ███╗   ███╗██╗   ██╗████████╗██╗  ██╗ ██████╗ ███████╗
    ████╗ ████║╚██╗ ██╔╝╚══██╔══╝██║  ██║██╔═══██╗██╔════╝
    ██╔████╔██║ ╚████╔╝    ██║   ███████║██║   ██║███████╗
    ██║╚██╔╝██║  ╚██╔╝     ██║   ██╔══██║██║   ██║╚════██║
    ██║ ╚═╝ ██║   ██║      ██║   ██║  ██║╚██████╔╝███████║
    ╚═╝     ╚═╝   ╚═╝      ╚═╝   ╚═╝  ╚═╝ ╚═════╝ ╚══════╝
```

### Capybara Tier · Claude Opus 4.6 · Strict Write Discipline

**The leaked Anthropic reasoning protocol. Running locally.**

[![Node.js](https://img.shields.io/badge/Node.js-20+-339933?style=flat-square&logo=node.js&logoColor=white)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-3178C6?style=flat-square&logo=typescript&logoColor=white)](https://typescriptlang.org)
[![Claude](https://img.shields.io/badge/Claude-Opus_4.6-cc785c?style=flat-square)](https://anthropic.com)
[![License](https://img.shields.io/badge/License-MIT-green?style=flat-square)](./LICENSE)

</div>

---

## What is this?

**mythos-router** is a local CLI power tool that implements the *leaked Anthropic "Capybara" reasoning protocol* — the specialized tier designed for PhD-level reasoning and cybersecurity analysis.

Unlike standard Claude wrappers, mythos-router enforces **Strict Write Discipline (SWD)**: every file operation the AI claims to perform is *verified against the actual filesystem*. If the model hallucinates a write, it gets a Correction Turn. If it fails twice, it yields to the human.

Zero slop. Zero hallucinated state. Full adaptive thinking.

---

## Features

| Feature | Description |
|---------|-------------|
| 🧠 **Adaptive Thinking** | Opus 4.6 with configurable effort levels (high/medium/low) |
| 🔒 **Strict Write Discipline** | Pre/post filesystem snapshots verify every model claim |
| 💤 **Self-Healing Memory** | `MEMORY.md` logs every action; auto-compresses via "Dream" |
| ⟲ **Correction Turns** | Model gets 2 retries to match filesystem reality, then yields |
| 📋 **Drift Detection** | `verify` command syncs codebase state with memory |
| 🚀 **Zero Build** | Runs directly via `tsx` — no compile step in dev |

---

## Installation

```bash
# Clone
git clone https://github.com/thewaltero/mythos-router.git
cd mythos-router

# Install
npm install

# Set your API key
export ANTHROPIC_API_KEY="sk-ant-..."
# Windows: $env:ANTHROPIC_API_KEY = "sk-ant-..."
```

---

## Usage

### `mythos chat` — Interactive Capybara Session

```bash
npx tsx src/cli.ts chat                  # Full power (high effort)
npx tsx src/cli.ts chat --effort low     # Budget mode
npx tsx src/cli.ts chat --effort medium  # Balanced
```

In-session commands:
- `/exit` — End session
- `/memory` — Show memory status
- `/clear` — Clear conversation (memory persists)

### `mythos verify` — Zero-Drift Codebase Scan

```bash
npx tsx src/cli.ts verify
```

Scans every file in your project and cross-references against `MEMORY.md`:
- ✅ **Verified** — File state matches memory
- ⚠️ **Drift** — File changed but memory doesn't reflect it
- ❌ **Missing** — Memory references a file that doesn't exist

### `mythos dream` — Memory Compression

```bash
npx tsx src/cli.ts dream          # Auto-compress when needed
npx tsx src/cli.ts dream --force  # Force compression
```

When `MEMORY.md` exceeds 100 entries, older logs are compressed into a summary block using Claude (low effort, minimal token burn). Recent entries are preserved intact.

---

## Architecture

```
mythos-router/
├── src/
│   ├── cli.ts           # Commander.js entry point
│   ├── config.ts        # Capybara system prompt + constants
│   ├── client.ts        # Anthropic SDK (adaptive thinking)
│   ├── swd.ts           # Strict Write Discipline engine
│   ├── memory.ts        # MEMORY.md self-healing manager
│   ├── utils.ts         # Terminal formatting (zero-dep)
│   └── commands/
│       ├── chat.ts      # Interactive REPL
│       ├── verify.ts    # Codebase ↔ Memory scanner
│       └── dream.ts     # Memory compression
├── .mythosignore        # SWD scan exclusions
├── MEMORY.md            # Auto-generated agentic memory
└── AGENTS.md            # Project conventions
```

### The SWD Protocol

```
User Input
    │
    ▼
[Pre-Snapshot] ── filesystem state captured
    │
    ▼
[Claude Opus 4.6] ── adaptive thinking (high effort)
    │
    ▼
[Parse FILE_ACTION blocks] ── extract claimed operations
    │
    ▼
[Post-Snapshot] ── filesystem state re-captured
    │
    ▼
[Verify] ── before vs. after vs. model claims
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

## The Capybara System Prompt

The system prompt implements the leaked Anthropic protocol:

> **Tier: Capybara** (Specialized in Cybersecurity & PhD Reasoning)
>
> Follow 'Strict Write Discipline' and never hallucinate filesystem state.
> Every file operation must be wrapped in `[FILE_ACTION]` blocks for verification.

The model is instructed to emit machine-readable delimiters around every file operation, making SWD verification 100% reliable.

---

## Configuration

| Env Variable | Required | Description |
|-------------|----------|-------------|
| `ANTHROPIC_API_KEY` | ✅ | Your Anthropic API key |

| File | Purpose |
|------|---------|
| `.mythosignore` | Patterns to exclude from SWD scanning |
| `MEMORY.md` | Auto-generated agentic memory log |

---

## Token Usage

| Mode | Typical Cost Per Turn |
|------|----------------------|
| `--effort high` | Full Opus 4.6 pricing (deep reasoning) |
| `--effort medium` | Balanced — good for most tasks |
| `--effort low` | Minimal thinking — quick answers |
| `dream` | Low effort summarization (~500 tokens) |

Token counts are displayed after every chat response.

---

## License

MIT

---

<div align="center">
<sub>Built with the leaked Capybara protocol. No affiliation with Anthropic. Use responsibly.</sub>
</div>
