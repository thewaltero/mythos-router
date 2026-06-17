// ─────────────────────────────────────────────────────────────
//  mythos-router :: escalation.ts
//  Verified Cost-Router — escalation-by-verification policy
// ─────────────────────────────────────────────────────────────
//
// The orchestrator already falls back between *providers* when one fails. This
// module adds an orthogonal, opt-in policy: start a task on the cheapest model
// tier and climb to a more capable one ONLY when the cheap tier's output fails
// Strict Write Discipline verification (i.e. a Correction Turn is triggered).
//
// This is the one cost optimization SWD makes possible that price-only routers
// cannot do safely: escalation is gated on *verified failure*, not on a guess
// about difficulty. If the cheap model's file actions verify, you never pay for
// the expensive one. The policy here is a pure function of (base effort,
// correction attempt number, ceiling); the chat correction loop consults it.
//
// Default behavior is unchanged: escalation is disabled unless explicitly
// enabled via `--escalate`, in which case the initial turn still runs at the
// base effort and only correction turns climb the ladder.

import { getEffort, type EffortLevel } from './config.js';

/**
 * Effort tiers ordered cheapest → most capable. Index = ladder rung.
 * Mirrors the `MODELS` map in config.ts (low → medium → high).
 */
export const EFFORT_LADDER: readonly EffortLevel[] = ['low', 'medium', 'high'] as const;

export const DEFAULT_ESCALATION_CEILING: EffortLevel = 'high';

export interface EscalationConfig {
  /** When false, the policy is a no-op and base effort is always used. */
  enabled: boolean;
  /** Escalation never climbs above this tier. Defaults to 'high'. */
  ceiling: EffortLevel;
}

/**
 * Ladder rung for an effort tier (low=0, medium=1, high=2).
 *
 * Unknown tiers map to the top rung. This is the fail-safe direction: an
 * unrecognized effort is treated as already-at-ceiling, so escalation declines
 * to climb rather than guessing a rung and burning a more expensive model.
 */
export function effortRank(effort: EffortLevel): number {
  const index = EFFORT_LADDER.indexOf(effort);
  return index === -1 ? EFFORT_LADDER.length - 1 : index;
}

/**
 * The next more-capable tier above `current`, or null if `current` is already
 * at or above `ceiling`. Pure; performs no I/O.
 */
export function nextEffort(
  current: EffortLevel,
  ceiling: EffortLevel = DEFAULT_ESCALATION_CEILING,
): EffortLevel | null {
  const currentRank = effortRank(current);
  const ceilingRank = effortRank(ceiling);
  if (currentRank >= ceilingRank) return null;
  return EFFORT_LADDER[currentRank + 1]!;
}

/**
 * Effort tier a given correction attempt should run at under verified
 * escalation.
 *
 * - `base`    the tier the session started at (e.g. the user's `--effort low`).
 * - `attempt` 1-based correction attempt number (the first correction is 1).
 *
 * Each correction attempt climbs exactly one rung above `base`, clamped to the
 * configured ceiling. The ceiling is itself clamped to be no lower than `base`,
 * so a misconfigured ceiling can never *demote* a run below the tier the user
 * asked for. When escalation is disabled the base tier is returned unchanged.
 *
 * Example (base='low', ceiling='high'): attempt 1 → 'medium', attempt 2 → 'high'.
 */
export function effortForCorrection(
  base: EffortLevel,
  attempt: number,
  config: EscalationConfig,
): EffortLevel {
  if (!config.enabled) return base;

  const baseRank = effortRank(base);
  // Ceiling may never sit below the base tier.
  const ceilingRank = Math.max(baseRank, effortRank(config.ceiling));
  // attempt is 1-based; a non-positive attempt is treated as "no climb".
  const climb = Number.isFinite(attempt) && attempt > 0 ? Math.floor(attempt) : 0;
  const targetRank = Math.min(baseRank + climb, ceilingRank);
  return EFFORT_LADDER[targetRank]!;
}

/** True when `current` is already at or above `config.ceiling` (no room to climb). */
export function isAtCeiling(current: EffortLevel, config: EscalationConfig): boolean {
  return effortRank(current) >= effortRank(config.ceiling);
}

export interface EscalationOptionInput {
  escalate?: boolean;
  escalateTo?: string;
}

/**
 * Build an EscalationConfig from raw CLI/option input. Disabled unless
 * `escalate` is truthy. The ceiling is parsed with the same lenient rules as
 * `--effort` (`getEffort`), so `--escalate-to med` etc. all work and an
 * unknown value falls back to 'high'.
 */
export function parseEscalationConfig(options: EscalationOptionInput): EscalationConfig {
  return {
    enabled: options.escalate === true,
    ceiling: options.escalateTo ? getEffort(options.escalateTo) : DEFAULT_ESCALATION_CEILING,
  };
}
