# BACKLOG.md — mythos-router

> Engineering considerations that are correct but not user-impacting under current scale.
> Revisit when SDK usage becomes external or system operates under sustained high concurrency.

---

## Runtime Hygiene

_(Dream duration tracking — resolved in 1.17.0: `dream` now records actual elapsed time.)_

---

## System Robustness (Scale-Dependent)

### Orchestrator complexity surface area
- **Component**: `orchestrator.ts`
- **Status**: Core routing paths — scoring/deterministic selection, fallback chains, circuit-breaker tripping, retry backoff, and concurrency release — are now covered by `test/orchestrator.test.ts`.
- **Behavior under scale**: Remaining concern is complexity itself (EMA scoring, watchdog, composite signals), not missing coverage
- **Consideration**: Still increases refactor risk and onboarding cost for external contributors
- **Revisit when**: Orchestrator becomes a stable external SDK dependency or undergoes major refactor

### Concurrent execution safety
- **Component**: `orchestrator.ts` (SDK surface)
- **Behavior under scale**: Concurrent `streamMessage` invocations may expose race conditions in concurrency control or telemetry aggregation
- **Consideration**: Currently low probability in CLI usage; increases under programmatic SDK adoption
- **Revisit when**: SDK is used in parallel request-heavy environments

---

## Context Management

### Token estimation accuracy
- **Component**: `chat.ts` (Context Guard)
- **Behavior under scale**: Length-based estimation may undercount structured or code-dense inputs
- **Consideration**: Risk of premature truncation or unexpected API boundary hits
- **Revisit when**: Users report reliability issues with long or structured conversations

### Compression ratio stability
- **Component**: `chat.ts` (Context Guard)
- **Behavior under scale**: Fixed 60% history compression may be suboptimal across mixed-density sessions
- **Consideration**: Can lead to either over-compression (loss of detail) or under-compression (context overflow risk)
- **Revisit when**: Context retention quality becomes a reported usability concern

### Recursive compression degradation
- **Component**: `chat.ts` (Context Guard)
- **Behavior under scale**: Repeated compression cycles may reduce information fidelity over long sessions
- **Consideration**: Risk of "summary-of-summary" drift in extreme usage patterns
- **Revisit when**: Long-running sessions become a primary usage pattern

---

## Nice-to-Have (Engineering Improvements)

| Area | Consideration |
|------|------|
| CLI output serialization | `--json` added to `stats` (1.17.0); `swd`/`receipts`/`runs` already support it. Remaining commands can follow the same pattern as needed. |
| Error classification | Replace string-matching with structured error types in orchestrator |
| Telemetry query robustness | Replace ID-based pagination with deterministic ordering (`ORDER BY id DESC LIMIT`) |
| Storage scalability | Current JSON-based metrics storage is sufficient until large session volumes (~5k+ sessions) |
