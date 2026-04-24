# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [1.2.1] — 2026-04-24

### Added
- **Multi Provider Orchestration Engine**: Decoupled the core application from the Anthropic SDK. The system now supports fallback routing, adaptive watchdogs, circuit breakers, and EMA-based performance scoring across multiple providers.
- **OpenAI & DeepSeek Support**: Added a native, zero-dependency `fetch`-based provider (`OpenAIProvider`) to seamlessly support OpenAI and DeepSeek endpoints (including streaming reasoning content for `o1` and `DeepSeek-R1`).
- **Skills Protocol**: Modular expert plugins via zero-dependency YAML frontmatter parsing. Skills (`-s <skill>`) can inject customized instructions, modify budget multipliers, and enforce deterministic provider selection.
- **Deterministic Response Caching**: SQLite-backed response caching for pure reasoning requests (like `verify` or `dream`). Bypass rule strictly ensures file mutating responses are never cached.
- **Centralized Pricing Registry**: Unified token cost calculator across different providers, feeding exact financial data into the budget metrics.
- **Auto-Healing TDD Loop**: Bounded, error-driven autonomy. Passing `--test-cmd` will automatically execute tests after a successful SWD mutation. If tests fail, the CLI intercepts `stderr`, truncates it, identifies TS/Runtime issues, and feeds it back to Claude for a self healing iteration.
- **TDD Anti-Thrashing Guards**: The orchestrator will automatically abort the healing loop if Claude attempts the exact same fix or if output remains identically broken, preventing runaway API costs.
  
### Security
- **CodeQL Integration**: Added GitHub CodeQL scanning

---

## [1.2.0] — 2026-04-23

### Added
- **SWDEngine v1 API**: Transactional filesystem execution kernel with `Plan → Snapshot → Execute → Verify → Rollback` lifecycle. Single entry point: `engine.run(actions)`.
- **ChatUI Abstraction**: Decoupled chat session logic from the terminal via a `ChatUI` interface. `ChatSession` is now a pure orchestrator, fully testable and reusable outside the CLI.
- **TerminalUI Implementation**: CLI-specific `ChatUI` adapter wrapping the Spinner and ANSI output.
- **SWD Lifecycle Hooks**: Extensibility layer (`onAction`, `onVerify`, `onRollback`) allowing consumers to inject logging, telemetry, or custom UI into the engine.
- **Rollback Auditability**: `SWDRunResult.rollbackErrors` field captures and reports rollback failures instead of silently swallowing them.
- **`swd-cli.ts`**: Separated SWD terminal presentation (verification output, dry-run preview, verbose traces) from the pure execution kernel.
- **Git Sandbox**: `ChatSession.setupSandbox()` for automated `mythos/` branch creation with nested-sandboxing protection.

### Changed
- **SWD Kernel is now I/O-free**: `swd.ts` contains zero `console.log` calls. All presentation lives in `swd-cli.ts`.

### Fixed
- **Snapshot memoization bug**: `InternalSessionContext.getSnapshot('after')` was returning stale cached state on multi-action same-file scenarios. After snapshots now always re-read disk state.

---

## [1.1.9] — 2026-04-22

### Added
- **Budget Analytics & Cost Profiling**: Persistent tracking of token usage and API costs across all sessions, projects, and commands.
- **`mythos stats` Command**: New reporting engine for financial transparency. Aggregate costs by command, project, or time period (last N days).
- **Global Metrics Store**: Local append-only JSON store in `~/.mythos-router/metrics.json` for cross-project financial auditing.
- **Session Instrumentation**: Automated recording of chat sessions and memory compression (dream) events.

---

## [1.1.8] — 2026-04-20

### Added
- **Self-Healing Memory (V4)**: Re-architected memory system with a dual Authority/Derivative model. `MEMORY.md` remains the sole source of truth, backed by a rebuildable SQLite index.
- **SQLite Derivative Index**: High-performance query acceleration layer using `node:sqlite`.
- **FTS5 Smart Search**: Intelligent, ranked text retrieval via FTS5 virtual tables with `unicode61` tokenization.
- **Integrity Signposting**: SHA-256 manifest hashing on startup ensuring zero drift between the authoritative log and the search index.
- **Atomic Rebuilds**: Transactional reconstruction logic (`BEGIN/COMMIT`) to ensure index consistency even during hard crashes.

### Changed
- **O(1) Append Protocol**: Optimized logging to use `appendFileSync` for better performance and durability under load.
- **Hardened Test Suite**: Expanded testing to verify SQLite initialization, FTS5 search ranking, and recovery logic.

---

## [1.1.7] — 2026-04-19

### Added
- **Interactive Inline Diffs**: High-fidelity terminal previews for dry-run mode. Review exact line changes with ANSI coloring and line numbering before applying.
- **Myers Diff Engine**: Implemented a zero-dependency, line-based shortest-edit-script algorithm in `src/diff.ts`.

### Changed
- **SWD Protocol Upgrade**: Updated the "Capybara" system prompt to include the `CONTENT` field for 100% verifiability of file operations.
- **Enhanced Regex Parsing**: Robust multi-line block extraction for complex code transfers.

---

## [1.1.6] — 2026-04-19

### Added
- **Atomic SWD Rollbacks**: Transactional filesystem safety. If any file action in a batch fails verification, the entire operation is reverted to its pristine state.
- **Claude Opus 4.7 Support**: Official integration as the default `high` effort model.
- **Adaptive Thinking Protocol**: Real-time streaming of model reasoning in the CLI REPL.
- **Enhanced Dry-Run Previews**: Per-action confirmation prompts with detailed diff-style metadata.
- **Adaptive Thinking Mode**: Full support in `client.ts` for thought-process streaming.

### Changed
- Updated model identifiers for Claude Opus 4.7 compatibility.
- Added SDK usage examples for programmatic integration.
- Updated pricing constants and tokenization logic for Opus 4.7 compatibility.
- Improved memory summarization "Dream" logic and session budget visualization.

### Fixed
- Deduplicated internal `progressBar` utility.
- `--effort` flag now validates input and warns on unrecognized values.
- Improved path traversal detection in `resolveSafePath`.
- Fixed memory leakage in long REPL sessions.

---

## [1.1.3] — 2026-04-17

### Added
- **Programmable SDK API**: Added the `src/index.ts` entry point and updated package module resolution.
- **Exposed Modules**: Native export of `{ runSWD, streamMessage, snapshotFiles }` for external integration.
- **SDK Documentation**: Integrated a new SDK Usage guide into the `README.md`.

---

## [1.1.2] — 2026-04-17

### Added
- **Multi-Model Orchestration**: Dynamic routing engine delegating tasks by effort (Opus 4.7 for Thinking, Sonnet 3.5 for Writing, Haiku 3 for Verifying).
- **Dynamic CLI Badging**: Terminal now explicitly displays the exact model assigned to the current session.
- **Protocol Tokenomics**: Added the official `TOKENOMICS.md`, formalizing the $MYTHOS Reasoning Tier Matrix.

---

## [1.1.1] — 2026-04-12

### Fixed
- **Zero-Drift Accuracy**: Filesystem scanner now recursively snapshots subdirectories for 100% drift detection.
- **True Dry-Run**: Fixed an issue where `MEMORY.md` was being created on disk even with the `--dry-run` flag.
- **Memory Example**: Enriched the default `MEMORY.md` to reflect real sessions with file modifications.
- **Codebase Polish**: Removed unused imports and obsolete Git-status checks.

---

## [1.1.0] — 2026-03-31

### Added
- **Financial Safety**: Hard budget cap and token tracker to prevent bill-shock.
- **Dry-Run Mode**: Preview all file operations with `[Y/n]` prompts before execution.
- **Strict Write Discipline**: Enhanced verification logic for cleaner code.
- **Zero-Drift Scanning**: Initial `verify` command implementation.

---

## [1.0.0] — 2026-03-29

### Added
- Initial release of mythos-router.
- **Strict Write Discipline (SWD)**: pre/post filesystem snapshot verification.
- **Adaptive Thinking**: Claude Opus with configurable effort levels.
- **Self-Healing Memory**: `MEMORY.md` auto-logging with verification status.
- **Correction Turns**: max 2 retries before yielding to human.
- **Dream/Verify Commands**: memory compression and drift detection.

[1.2.1]: https://github.com/thewaltero/mythos-router/releases/tag/v1.2.1
[1.2.0]: https://github.com/thewaltero/mythos-router/releases/tag/v1.2.0
[1.1.9]: https://github.com/thewaltero/mythos-router/releases/tag/v1.1.9
[1.1.8]: https://github.com/thewaltero/mythos-router/releases/tag/v1.1.8
[1.1.7]: https://github.com/thewaltero/mythos-router/releases/tag/v1.1.7
[1.1.6]: https://github.com/thewaltero/mythos-router/releases/tag/v1.1.6
[1.1.3]: https://github.com/thewaltero/mythos-router/releases/tag/v1.1.3
[1.1.2]: https://github.com/thewaltero/mythos-router/releases/tag/v1.1.2
[1.1.1]: https://github.com/thewaltero/mythos-router/releases/tag/v1.1.1
[1.1.0]: https://github.com/thewaltero/mythos-router/releases/tag/v1.1.0
[1.0.0]: https://github.com/thewaltero/mythos-router/releases/tag/v1.0.0
