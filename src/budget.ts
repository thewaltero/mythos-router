// ─────────────────────────────────────────────────────────────
//  mythos-router :: budget.ts
//  Session Budget Limiter — Financial safety switch
// ─────────────────────────────────────────────────────────────

import {
  DEFAULT_MAX_TOKENS_PER_SESSION,
  DEFAULT_MAX_TURNS,
  BUDGET_WARN_PERCENT,
  COST_PER_INPUT_TOKEN,
  COST_PER_OUTPUT_TOKEN,
} from './config.js';
import { c } from './utils.js';

// ── Types ────────────────────────────────────────────────────
export interface BudgetConfig {
  maxTokens: number;
  maxTurns: number;
  warnAtPercent: number;
  /** Cost per input token in USD (update when Anthropic changes pricing) */
  costPerInputToken: number;
  /** Cost per output token in USD (update when Anthropic changes pricing) */
  costPerOutputToken: number;
}

export interface BudgetCheck {
  ok: boolean;
  reason?: string;
  tokensPercent: number;
  turnsPercent: number;
  warning: boolean;
  /** True when budget is exhausted — signals the caller to perform a graceful save */
  exhausted: boolean;
}

export interface BudgetSnapshot {
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  turns: number;
  maxTokens: number;
  maxTurns: number;
  startedAt: number;
  elapsedMs: number;
  /** Estimated cost in USD based on configured token pricing */
  estimatedCostUSD: number;
}

// ── Session Budget Class ─────────────────────────────────────
export class SessionBudget {
  private config: BudgetConfig;
  private totalInput = 0;
  private totalOutput = 0;
  private turnCount = 0;
  private startedAt: number;
  private enabled: boolean;

  constructor(config?: Partial<BudgetConfig>, enabled = true) {
    this.config = {
      maxTokens: config?.maxTokens ?? DEFAULT_MAX_TOKENS_PER_SESSION,
      maxTurns: config?.maxTurns ?? DEFAULT_MAX_TURNS,
      warnAtPercent: config?.warnAtPercent ?? BUDGET_WARN_PERCENT,
      costPerInputToken: config?.costPerInputToken ?? COST_PER_INPUT_TOKEN,
      costPerOutputToken: config?.costPerOutputToken ?? COST_PER_OUTPUT_TOKEN,
    };
    this.startedAt = Date.now();
    this.enabled = enabled;
  }

  // ── Record token usage after an API call ─────────────────
  record(inputTokens: number, outputTokens: number): void {
    this.totalInput += inputTokens;
    this.totalOutput += outputTokens;
    this.turnCount++;
  }

  // ── Check if budget is still ok ──────────────────────────
  check(): BudgetCheck {
    if (!this.enabled) {
      return { ok: true, tokensPercent: 0, turnsPercent: 0, warning: false, exhausted: false };
    }

    const totalTokens = this.totalInput + this.totalOutput;
    const tokensPercent = (totalTokens / this.config.maxTokens) * 100;
    const turnsPercent = (this.turnCount / this.config.maxTurns) * 100;
    const warning =
      tokensPercent >= this.config.warnAtPercent ||
      turnsPercent >= this.config.warnAtPercent;

    // Token limit exceeded
    if (totalTokens >= this.config.maxTokens) {
      return {
        ok: false,
        exhausted: true,
        reason:
          `Session budget exhausted: ${totalTokens.toLocaleString()}/${this.config.maxTokens.toLocaleString()} tokens ` +
          `used across ${this.turnCount} turns. ` +
          `Use --max-tokens <n> to increase or --no-budget to disable.`,
        tokensPercent: Math.min(tokensPercent, 100),
        turnsPercent,
        warning: true,
      };
    }

    // Turn limit exceeded
    if (this.turnCount >= this.config.maxTurns) {
      return {
        ok: false,
        exhausted: true,
        reason:
          `Session turn limit reached: ${this.turnCount}/${this.config.maxTurns} turns. ` +
          `Use --max-turns <n> to increase or --no-budget to disable.`,
        tokensPercent,
        turnsPercent: Math.min(turnsPercent, 100),
        warning: true,
      };
    }

    return { ok: true, tokensPercent, turnsPercent, warning, exhausted: false };
  }

  // ── Get current snapshot ─────────────────────────────────
  status(): BudgetSnapshot {
    const estimatedCostUSD =
      this.totalInput * this.config.costPerInputToken +
      this.totalOutput * this.config.costPerOutputToken;
    return {
      totalTokens: this.totalInput + this.totalOutput,
      inputTokens: this.totalInput,
      outputTokens: this.totalOutput,
      turns: this.turnCount,
      maxTokens: this.config.maxTokens,
      maxTurns: this.config.maxTurns,
      startedAt: this.startedAt,
      elapsedMs: Date.now() - this.startedAt,
      estimatedCostUSD,
    };
  }

  // ── Is budget enforcement enabled? ───────────────────────
  isEnabled(): boolean {
    return this.enabled;
  }

  // ── Format a visual budget bar for the terminal ──────────
  formatBar(width = 20): string {
    if (!this.enabled) {
      return `${c.dim}budget: ${c.yellow}disabled${c.dim} (expert mode)${c.reset}`;
    }

    const snap = this.status();
    const tokPct = Math.min(
      (snap.totalTokens / snap.maxTokens) * 100,
      100
    );
    const turnPct = Math.min(
      (snap.turns / snap.maxTurns) * 100,
      100
    );

    const tokBar = progressBar(tokPct, width);
    const turnBar = progressBar(turnPct, Math.floor(width / 2));

    const tokColor = tokPct >= 90 ? c.red : tokPct >= this.config.warnAtPercent ? c.yellow : c.green;
    const turnColor = turnPct >= 90 ? c.red : turnPct >= this.config.warnAtPercent ? c.yellow : c.green;

    const elapsed = formatElapsed(snap.elapsedMs);

    return (
      `${c.dim}budget:${c.reset} ` +
      `${tokColor}${tokBar}${c.reset} ` +
      `${tokColor}${snap.totalTokens.toLocaleString()}${c.dim}/${snap.maxTokens.toLocaleString()} tokens${c.reset} · ` +
      `${turnColor}${turnBar}${c.reset} ` +
      `${turnColor}${snap.turns}${c.dim}/${snap.maxTurns} turns${c.reset} · ` +
      `${c.dim}~$${snap.estimatedCostUSD.toFixed(4)} · ${elapsed}${c.reset}`
    );
  }

  // ── Format warning message if at threshold ───────────────
  formatWarning(): string | null {
    if (!this.enabled) return null;

    const { warning, ok, tokensPercent, turnsPercent } = this.check();

    if (!ok) {
      const snap = this.status();
      return (
        `${c.yellow}${c.bold}⏸ BUDGET REACHED — Graceful Save${c.reset}\n` +
        `${c.dim}  ${snap.totalTokens.toLocaleString()} tokens consumed across ${snap.turns} turns (~$${snap.estimatedCostUSD.toFixed(4)}).${c.reset}\n` +
        `${c.green}  Progress saved to MEMORY.md. Resume with ${c.cyan}mythos chat${c.green} to continue.${c.reset}\n` +
        `${c.dim}  Increase limits: ${c.cyan}mythos chat --max-tokens 1000000 --max-turns 50${c.reset}\n` +
        `${c.dim}  Disable limits:  ${c.cyan}mythos chat --no-budget${c.reset}`
      );
    }

    if (warning) {
      const higher = Math.max(tokensPercent, turnsPercent);
      const snap = this.status();
      return (
        `${c.yellow}⚠ Budget ${Math.round(higher)}% consumed${c.reset} — ` +
        `${c.dim}${snap.totalTokens.toLocaleString()} tokens · ${snap.turns} turns${c.reset}`
      );
    }

    return null;
  }

  // ── Graceful session summary for MEMORY.md ────────────────
  formatSessionSummary(): string {
    const snap = this.status();
    const elapsed = formatElapsed(snap.elapsedMs);
    return (
      `budget-save: ${snap.totalTokens.toLocaleString()} tokens · ` +
      `${snap.turns} turns · ~$${snap.estimatedCostUSD.toFixed(4)} · ${elapsed}`
    );
  }
}

// ── Progress Bar Helper ──────────────────────────────────────
function progressBar(percent: number, width: number): string {
  const filled = Math.round((percent / 100) * width);
  const empty = width - filled;
  return `[${`█`.repeat(filled)}${`░`.repeat(empty)}]`;
}

// ── Elapsed Time Formatter ───────────────────────────────────
function formatElapsed(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const secs = seconds % 60;
  if (minutes < 60) return `${minutes}m ${secs}s`;
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return `${hours}h ${mins}m`;
}
