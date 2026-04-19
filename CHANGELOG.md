# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
- **Multi-Model Orchestration** — Dynamic routing engine delegating tasks by effort (Opus 4.7 for Thinking, Sonnet 3.5 for Writing, Haiku 3 for Verifying).
- **Dynamic CLI Badging** — Terminal now explicitly displays the exact model assigned to the current session.
- **Protocol Tokenomics** — Added the official `TOKENOMICS.md`, formalizing the $MYTHOS Reasoning Tier Matrix.

---

## [1.1.1] — 2026-04-12

### Fixed
- **Zero-Drift Accuracy** — Filesystem scanner now recursively snapshots subdirectories for 100% drift detection.
- **True Dry-Run** — Fixed an issue where `MEMORY.md` was being created on disk even with the `--dry-run` flag.
- **Memory Example** — Enriched the default `MEMORY.md` to reflect real sessions with file modifications.
- **Codebase Polish** — Removed unused imports and obsolete Git-status checks.

---

## [1.1.0] — 2026-03-31

### Added
- **Financial Safety** — Hard budget cap and token tracker to prevent bill-shock.
- **Dry-Run Mode** — Preview all file operations with `[Y/n]` prompts before execution.
- **Strict Write Discipline** — Enhanced verification logic for cleaner code.
- **Zero-Drift Scanning** — Initial `verify` command implementation.

---

## [1.0.0] — 2026-03-29

### Added
- Initial release of mythos-router.
- **Strict Write Discipline (SWD)** — pre/post filesystem snapshot verification.
- **Adaptive Thinking** — Claude Opus with configurable effort levels.
- **Self-Healing Memory** — `MEMORY.md` auto-logging with verification status.
- **Correction Turns** — max 2 retries before yielding to human.
- **Dream/Verify Commands** — memory compression and drift detection.

[1.1.7]: https://github.com/thewaltero/mythos-router/releases/tag/v1.1.7
[1.1.6]: https://github.com/thewaltero/mythos-router/releases/tag/v1.1.6
[1.1.3]: https://github.com/thewaltero/mythos-router/releases/tag/v1.1.3
[1.1.2]: https://github.com/thewaltero/mythos-router/releases/tag/v1.1.2
[1.1.1]: https://github.com/thewaltero/mythos-router/releases/tag/v1.1.1
[1.1.0]: https://github.com/thewaltero/mythos-router/releases/tag/v1.1.0
[1.0.0]: https://github.com/thewaltero/mythos-router/releases/tag/v1.0.0
