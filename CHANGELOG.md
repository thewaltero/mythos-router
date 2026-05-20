# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [1.10.0] - 2026-05-20

### Added
- **`mythos skills` Command** - Added first-class skill pack management through `mythos skills`, `mythos skills show <name>`, `mythos skills new <name>`, and `mythos skills check`.
- **Project-Local Skill Packs** - Added `.mythos/skills/<name>/SKILL.md` support so repositories can ship their own Mythos operating rules without relying on a user's global setup.
- **Global Skill Packs** - Preserved reusable user-global skills in `~/.mythos-router/skills/<name>/SKILL.md`, with project-local skills taking precedence when names overlap.
- **Skill Receipt Metadata** - SWD receipts now record active skill ids, names, versions, and sources so verified edits can be reviewed with the rule packs that guided them.
- **Skill Documentation and Examples** - Added a dedicated skills guide plus example `repo` and `security-review` skill packs.
- **Skill SDK Helpers** - Exported skill loading, listing, validation, creation, and prompt-building helpers through the public SDK entry point.

### Changed
- **Project Initialization** - `mythos init` now scaffolds and checks the project-local `.mythos/skills/` directory as part of repo onboarding.
- **Skill Validation** - Skill checks now validate numeric limits, parse frontmatter arrays more consistently, and detect incompatibilities by either skill id or skill name.
- **Receipt Privacy** - Receipt skill paths are stored only when they resolve inside the current project, avoiding accidental leakage of user-global or outside-project paths.

---

## [1.9.0] - 2026-05-19

### Added
- **`mythos run` Command** - Added one-shot prompt execution for tasks that do not need the interactive REPL. The command accepts any prompt, runs it through Mythos once, and exits.
- **File and Stdin Prompt Sources** - `mythos run` can now read its prompt from a local file with `--file <path>` or from piped input with `--stdin`, making Mythos easier to use in scripts, task files, and editor workflows.
- **Shared Chat/SWD Pipeline** - `run` reuses the existing chat session initialization, provider routing, SWD verification, receipts, memory logging, budget tracking, skills, and branch sandboxing instead of introducing a separate execution path.
- **Bounded Run Defaults** - One-shot runs default to a smaller turn budget: one initial model turn, SWD correction turns, and optional test-healing turns only when `--test-cmd` is provided.
- **Resume-Safe Execution** - `run` records metrics as its own command but does not overwrite the resumable session used by `mythos chat --resume`.
- **`mythos init --check`** - Added a read-only setup check for environment, providers, `.mythosignore`, `MEMORY.md`, and the local skills directory without scaffolding or modifying files.

### Changed
- **Command Help Coverage** - CLI smoke coverage now checks that built help output includes the `run` and `init` commands, verifies the `run --help` prompt-source options, and covers `init --check` as a no-write smoke path.

---

## [1.8.1] - 2026-05-17

### Fixed
- **SWD Rollback Drift Protection** — Rollback now uses the cached post-verification snapshot, preventing Mythos from overwriting external file changes made after verification.

### Changed
- **CI Verification Gate** — Added a GitHub Actions step to run `node dist/cli.js verify --ci` against the locally built CLI.
- **CI Hardening** — Tightened workflow permissions and install behavior.

### Security
- **Local Data Disclosure** - Documented where Mythos stores local memory, receipts, resumable sessions, metrics, cache data, and skills so users can inspect or clear private project state.

---

## [1.8.0] — 2026-05-15

### Added
- **CI Verification Mode** — Added `mythos verify --ci`, a read-only GitHub CI mode for reviewing PR/diff changes before merge
- **Generic PR Review** — `verify --ci` now works even when no Mythos receipts are present, checking high-impact repository changes in generic PR-review mode.
- **Receipt-Aware CI Checks** — When Mythos receipts are changed under `.mythos/receipts/`, CI verifies receipt integrity and changed-file coverage.
- **Execution-Surface Detection** — Added CI checks for `package.json` script changes, npm lifecycle hooks, GitHub Actions workflows, shell/deploy/Docker surfaces, `.env`/`.npmrc` paths, private-key-like files, and high-confidence secret patterns.
- **CI Output Options** — Added `--strict`, `--json`, and `--base <ref>` options for stricter CI policies, downstream tooling, and custom git base comparisons.
- **CI Documentation** — Added `docs/CI.md` with GitHub Actions setup, exit behavior, examples, and maintainer notes.

### Changed
- **Verify Command Extension** — Extended `mythos verify` with a dedicated CI path while keeping normal local verification behavior unchanged.
- **Test-Healing Loop Refactor** — Refactored the test-healing loop in `src/commands/chat.ts` into smaller helper methods for maintainability, without changing existing chat/SWD behavior.

### Security
- **No-AI CI Verification** — `verify --ci` does not call a model, use provider fallback, modify files, execute SWD actions, or write to `MEMORY.md`.
- **Lifecycle Hook Review** — Newly added npm install lifecycle hooks such as `preinstall`, `install`, and `postinstall` are treated as high-severity CI findings.
- **Execution-Surface Review** — Package scripts, workflows, shell/deploy files, and other high-impact repo surfaces are flagged for review before merge.
- **Sensitive File Checks** — Added high-confidence checks for sensitive paths, private-key-like files, and secret-like material.

---

## [1.7.1] — 2026-05-13

### Added
- **Malformed Action Detection** — Mythos now warns when model output appears to include `[FILE_ACTION]` blocks but no valid actions can be parsed, making broken agent output easier to diagnose.
- **Safety Regression Coverage** — Added tests covering receipt redaction, dry-run wording, and oversized write blocking.

### Changed
- **Safer Receipt Output** — Receipt test-output tails are now limited to 500 characters and redact obvious API keys, tokens, and secrets before being stored locally.

### Fixed
- **Large Write Protection** — Oversized `CREATE` and `MODIFY` actions are now blocked before touching disk, reducing the risk of unsafe full-file rewrites.

---

## [1.7.0] — 2026-05-11

### Added
- **SWD Trust Receipts** — Added persistent receipts for SWD runs, recording verified file outcomes, request summaries, provider/model metadata, token usage, git context, test status, and an integrity hash for later audit.
- **`mythos receipts` Command** — Added receipt listing, inspection, and drift verification through `mythos receipts`, `mythos receipts show <id|latest>`, and `mythos receipts verify <id|latest>`, with `--json` output for automation.

### Fixed
- **Machine-Readable JSON Output** — Terminal cursor restoration no longer contaminates redirected stdout, keeping `--json` output parseable in CI and shell pipelines.

---

## [1.6.1] — 2026-05-06

### Fixed
- **SWD Metadata Accuracy** — File hash metadata is now written only after successful, non-rolled-back SWD runs, preventing stale verification data after failed writes or rollbacks.
- **Dream Metadata Preservation** — Memory compression now preserves `mythos:file` metadata, keeping SHA-256 drift detection intact after `mythos dream`.
- **Test-Healing Drift Tracking** — Successful SWD fixes produced during test-healing now record file metadata for later verification.
- **Anthropic Timeout Handling** — Anthropic requests now receive abort signals directly, improving watchdog timeout and fallback reliability during stalled streams.

---

## [1.6.0] — 2026-05-03

### Added
- **Cryptographic Drift Detection** — `mythos verify` now supports SHA-256 hash comparison for SWD-managed files. Hidden `mythos:file` metadata blocks in `MEMORY.md` store file state, allowing the verifier to detect manual edits, missing files, and unexpected content changes.
- **CLI Smoke Tests** — Added `test/cli.test.ts` to validate the build lifecycle, built CLI execution, and `verify --dry-run` behavior in isolated temporary directories.
- **Defensive Parser Limits** — Added a 250,000-character SWD block limit and stricter rejection of unsafe paths, including absolute paths, null bytes, traversal attempts, and oversized path values.

### Changed
- **Terminal Visual System** — Added semantic `theme` and `icon` constants, improved mode badges, updated session/help/exit cards, and standardized success/warning/error/info colors across CLI output.
- **Signal Handling** — Refined shutdown behavior so graceful exits return code `0`, while uncaught exceptions finalize safely and return code `1`.
- **Mutation-Safe Cache Behavior** — Updated `ResponseCache` to bypass responses containing `[FILE_ACTION:]`, preventing file-mutating responses from being cached or replayed.
- **Explicit `/clear` Confirmation** — Replaced interactive confirmation with `/clear confirm` to avoid nested readline conflicts in the chat REPL.

### Fixed
- **SWD Parser Resilience** — Fixed handling of truncated or malformed `[FILE_ACTION:]` blocks to prevent parser stalls on incomplete model output.
- **Verify Path Normalization** — Improved path normalization in `verify` to reduce false-positive drift results across relative path formats.

---

## [1.5.3] — 2026-05-01

### Fixed

- **Graceful Shutdown** — Removed competing `process.exit(0)` calls from `cli.ts` and `telemetry.ts` SIGINT handlers. Chat's `safeExit()` now fully owns the exit lifecycle, ensuring session save, metrics, and finalization always complete on Ctrl+C.
- **SWD Content Preservation** — Replaced `.trim()` with precise boundary-newline removal in `parseActions()` so file content whitespace (leading spaces, trailing newlines, blank lines) is preserved exactly.
- **Verify False Positives** — Fixed regex in `extractMentionedPaths()` that was including `chat:` entries and trailing semicolons as file paths, causing phantom "missing file" reports.
- **Session Resume Turn Count** — Added `SessionBudget.restore()` so resumed sessions correctly hydrate token and turn counts instead of resetting to 1.

### Security
- **Shell Safety** — `git.ts` uses `execFileSync` with argument arrays instead of string interpolation.

---

## [1.5.0] — 2026-04-30

### Added
- **`mythos init` Command** — Single-command project onboarding with environment validation (Node.js version, SQLite, Git), provider detection with actionable fix hints, and automatic scaffolding of `.mythosignore`, `MEMORY.md`, and skills directory.
- **Project Scaffolding** — Automatically creates `.mythosignore` with sensible defaults to prevent accidental scanning of `node_modules` and other build artifacts.

### Changed
- **Polished CLI Output** — Simplified internal jargon in user-facing logs (e.g., "derivative index" → "memory index").
- **Experimental Warning Suppression** — Automatically suppresses Node.js `ExperimentalWarning` for SQLite to maintain a premium, stable CLI experience.
- **Provider Clarity** — Explicitly labels Anthropic as `required` and others as `optional` during initialization, providing clearer setup instructions.

### Fixed
- **Dead Code Cleanup** — Removed orphan Next.js API routes that were accidentally included in the CLI repository.

---

## [1.4.0] — 2026-04-27

### Added
- **Session persistence & resume support** — Sessions are now atomically saved to `~/.mythos-router/sessions/latest.json` on exit. `mythos chat --resume` restores conversation history and budget state.
- **Context window guard** — Automatically compresses the oldest portion of conversation history when approaching token limits using a low-effort summarization step. Prevents context overflow crashes during long sessions.

### Fixed
- **CLI signal handling** — Improved handling of `SIGINT`, `SIGTERM`, and `uncaughtException`, ensuring terminal state is restored and sessions are safely persisted on exit or crash.
- **Commander.js lifecycle** — Switched to `program.parseAsync()` to properly handle async command execution and prevent unhandled promise issues.
- **Startup race condition** — Removed a dynamic import in the default help path that could cause banner inconsistencies in some environments.

---

## [1.3.1] — 2026-04-27

### Added
- **Developer Experience**: Added a `BACKLOG.md` to cleanly track and categorize deferred architectural decisions and future system robustness plans.

### Fixed
- **CLI Robustness**: The terminal cursor is now safely restored if the CLI process crashes mid-animation, preventing the "invisible cursor" terminal bug.
- **Provider Concurrency**: Fixed a decrement scoping bug in the `ProviderOrchestrator` ensuring `maxConcurrency` limits are strictly enforced even under parallel SDK usage.
- **SQLite Compatibility**: Centralized `node:sqlite` loading into a single robust loader module, allowing the tool to fail gracefully instead of crashing on unsupported Node environments.

## [1.3.0] — 2026-04-26

### Added
- **Provider Observability Dashboard** — Added the `mythos providers` command. A real-time, terminal-based dashboard that surfaces EMA latency trends, success rates, circuit breaker recovery ETAs, and a live "Leader" score. Includes a zero-flicker `--watch` mode.
- **SQLite Telemetry Backend** — Orchestration events are now persistently streamed to a dedicated `telemetry.db` using WAL pragmas and an asynchronous batching queue to guarantee zero hot-path blocking.
- **Contextual Decision Tracing** — The engine no longer just routes; it explains *why*. Routing traces now explicitly capture task type (`chat`, `code`, `analysis`), input token buckets, and latency-vs-success-rate reasoning logs.
- **Automated Retention Policies** — The telemetry engine aggressively self-prunes history, maintaining only the last 1,000 routing events and truncating error stack traces to prevent long-term database bloat.

## [1.2.1]

### Added
- **Multi-Provider Orchestration Engine** — Decoupled the core application from the Anthropic SDK. The system now supports fallback routing, adaptive watchdogs, circuit breakers, and EMA-based performance scoring across multiple providers.
- **OpenAI & DeepSeek Support** — Added a native, zero-dependency `fetch`-based provider (`OpenAIProvider`) to seamlessly support OpenAI and DeepSeek endpoints (including streaming reasoning content for `o1` and `DeepSeek-R1`).
- **Skills Protocol** — Modular expert plugins via zero-dependency YAML frontmatter parsing. Skills (`-s <skill>`) can inject customized instructions, modify budget multipliers, and enforce deterministic provider selection.
- **Deterministic Response Caching** — SDK utility for SQLite-backed response caching for pure-reasoning requests. Bypass rule strictly ensures file-mutating responses are never cached.
- **Centralized Pricing Registry** — Unified token cost calculator across different providers, feeding exact financial data into the budget metrics.
- **Auto-Healing TDD Loop** — Bounded, error-driven autonomy. Passing `--test-cmd` will automatically execute tests after a successful SWD mutation. If tests fail, the CLI intercepts `stderr`, truncates it, identifies TS/Runtime issues, and feeds it back to Claude for a self-healing iteration.
- **TDD Anti-Thrashing Guards** — The orchestrator will automatically abort the healing loop if Claude attempts the exact same fix or if output remains identically broken, preventing runaway API costs.
- **Contributor Covenant** — Added `CODE_OF_CONDUCT.md` to formally establish community standards.

### Fixed
- **Stable Provider Fallback** — Fixed an edge case in the `ProviderOrchestrator` where identical EMA scores (e.g., at startup) could cause unpredictable provider routing due to JS `sort()` instability. The engine now explicitly respects user-configured priorities as a tie-breaker.

### Security
- **CodeQL Integration** — Added GitHub CodeQL scanning badge to `README.md`.
- **Dependency Audit** — Triaged and validated false-positive Socket.dev supply chain alerts for `@anthropic-ai/sdk`.

---
## [1.2.0] — 2026-04-23

### Added
- **SWDEngine v1 API** — Transactional filesystem execution kernel with `Plan → Snapshot → Execute → Verify → Rollback` lifecycle. Single entry point: `engine.run(actions)`.
- **ChatUI Abstraction** — Decoupled chat session logic from the terminal via a `ChatUI` interface. `ChatSession` is now a pure orchestrator, fully testable and reusable outside the CLI.
- **TerminalUI Implementation** — CLI-specific `ChatUI` adapter wrapping the Spinner and ANSI output.
- **SWD Lifecycle Hooks** — Extensibility layer (`onAction`, `onVerify`, `onRollback`) allowing consumers to inject logging, telemetry, or custom UI into the engine.
- **Rollback Auditability** — `SWDRunResult.rollbackErrors` field captures and reports rollback failures instead of silently swallowing them.
- **`swd-cli.ts`** — Separated SWD terminal presentation (verification output, dry-run preview, verbose traces) from the pure execution kernel.
- **Git Sandbox** — `ChatSession.setupSandbox()` for automated `mythos/` branch creation with nested-sandboxing protection.

### Changed
- **SWD Kernel is now I/O-free** — `swd.ts` contains zero `console.log` calls. All presentation lives in `swd-cli.ts`.
- **`validateApiKey()` throws instead of `process.exit(1)`** — library-safe error handling.
- **SDK exports (`index.ts`) fully updated** — removed dead symbols (`runSWD`, `parseFileActions`, `snapshotFiles`), added `SWDEngine`, `parseActions`, `SessionBudget`, `ChatUI`, and all v1 types.

### Fixed
- **🔴 Snapshot memoization bug** — `InternalSessionContext.getSnapshot('after')` was returning stale cached state on multi-action same-file scenarios. After snapshots now always re-read disk state.
- **🔴 Broken `index.ts` exports** — SDK entry point was referencing pre-refactor symbols that no longer existed.

---

## [1.1.9] — 2026-04-22

### Added
- **Budget Analytics & Cost Profiling** — Persistent tracking of token usage and API costs across all sessions, projects, and commands.
- **`mythos stats` Command** — New reporting engine for financial transparency. Aggregate costs by command, project, or time period (last N days).
- **Global Metrics Store** — Local append-only JSON store in `~/.mythos-router/metrics.json` for cross-project financial auditing.
- **Session Instrumentation** — Automated recording of chat sessions and memory compression (dream) events.

---

## [1.1.8] — 2026-04-20

### Added
- **Self-Healing Memory (V4)** — Re-architected memory system with a dual Authority/Derivative model. `MEMORY.md` remains the sole source of truth, backed by a rebuildable SQLite index.
- **SQLite Derivative Index** — High-performance query acceleration layer using `node:sqlite`.
- **FTS5 Smart Search** — Intelligent, ranked text retrieval via FTS5 virtual tables with `unicode61` tokenization.
- **Integrity Signposting** — SHA-256 manifest hashing on startup ensuring zero drift between the authoritative log and the search index.
- **Atomic Rebuilds** — Transactional reconstruction logic (`BEGIN/COMMIT`) to ensure index consistency even during hard crashes.

### Changed
- **O(1) Append Protocol** — Optimized logging to use `appendFileSync` for better performance and durability under load.
- **Hardened Test Suite** — Expanded testing to verify SQLite initialization, FTS5 search ranking, and recovery logic.

---

## [1.1.7] — 2026-04-19

### Added
- **Interactive Inline Diffs** — High-fidelity terminal previews for dry-run mode. Review exact line changes with ANSI coloring and line numbering before applying.
- **Myers Diff Engine** — Implemented a zero-dependency, line-based shortest-edit-script algorithm in `src/diff.ts`.

### Changed
- **SWD Protocol Upgrade** — Updated the "Capybara" system prompt to include the `CONTENT` field for 100% verifiability of file operations.
- **Enhanced Regex Parsing** — Robust multi-line block extraction for complex code transfers.

---

## [1.1.6] — 2026-04-19

### Added
- **Atomic SWD Rollbacks** — Transactional filesystem safety. If any file action in a batch fails verification, the entire operation is reverted to its pristine state.
- **Claude Opus 4.7 Support** — Official integration as the default `high` effort model.
- **Adaptive Thinking Protocol** — Real-time streaming of model reasoning in the CLI REPL.
- **Enhanced Dry-Run Previews** — Per-action confirmation prompts with detailed diff-style metadata.
- **Adaptive Thinking Mode** — Full support in `client.ts` for thought-process streaming.

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
- **Programmable SDK API** — Added the `src/index.ts` entry point and updated package module resolution.
- **Exposed Modules** — Native export of `{ runSWD, streamMessage, snapshotFiles }` for external integration.
- **SDK Documentation** — Integrated a new SDK Usage guide into the `README.md`.

---

## [1.1.2] — 2026-04-17

### Added
- **Multi-Model Orchestration** — Dynamic routing engine delegating tasks by effort (Opus 4.7 for Thinking, Sonnet 4.6 for Writing, Haiku 4.5 for Verifying).
- **Dynamic CLI Badging** — Terminal now explicitly displays the exact model assigned to the current session.
- **Protocol Tokenomics** — Added the official `TOKENOMICS.md`, formalizing the $MYTHOS Reasoning Tier Matrix.

---

## [1.1.1] — 2026-04-12

### Fixed
- **File Existence Accuracy** — Filesystem scanner recursively checks file existence for basic drift detection.
- **True Dry-Run** — Fixed an issue where `MEMORY.md` was being created on disk even with the `--dry-run` flag.
- **Memory Example** — Enriched the default `MEMORY.md` to reflect real sessions with file modifications.
- **Codebase Polish** — Removed unused imports and obsolete Git-status checks.

---

## [1.1.0] — 2026-03-31

### Added
- **Financial Safety** — Budget limits and token tracker to help prevent bill-shock.
- **Dry-Run Mode** — Preview all file operations with `[Y/n]` prompts before execution.
- **Strict Write Discipline** — Enhanced verification logic for cleaner code.
- **Codebase Verification** — Initial `verify` command implementation.

---

## [1.0.0] — 2026-03-29

### Added
- Initial release of mythos-router.
- **Strict Write Discipline (SWD)** — pre/post filesystem snapshot verification.
- **Adaptive Thinking** — Claude Opus with configurable effort levels.
- **Self-Healing Memory** — `MEMORY.md` auto-logging with verification status.
- **Correction Turns** — max 2 retries before yielding to human.
- **Dream/Verify Commands** — memory compression and drift detection.

[1.10.0]: https://github.com/thewaltero/mythos-router/releases/tag/v1.10.0
[1.9.0]: https://github.com/thewaltero/mythos-router/releases/tag/v1.9.0
[1.8.1]: https://github.com/thewaltero/mythos-router/releases/tag/v1.8.1
[1.8.0]: https://github.com/thewaltero/mythos-router/releases/tag/v1.8.0
[1.7.1]: https://github.com/thewaltero/mythos-router/releases/tag/v1.7.1
[1.7.0]: https://github.com/thewaltero/mythos-router/releases/tag/v1.7.0
[1.6.1]: https://github.com/thewaltero/mythos-router/releases/tag/v1.6.1
[1.6.0]: https://github.com/thewaltero/mythos-router/releases/tag/v1.6.0
[1.5.3]: https://github.com/thewaltero/mythos-router/releases/tag/v1.5.3
[1.5.0]: https://github.com/thewaltero/mythos-router/releases/tag/v1.5.0
[1.4.0]: https://github.com/thewaltero/mythos-router/releases/tag/v1.4.0
[1.3.1]: https://github.com/thewaltero/mythos-router/releases/tag/v1.3.1
[1.3.0]: https://github.com/thewaltero/mythos-router/releases/tag/v1.3.0
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
