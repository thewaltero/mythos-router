// ─────────────────────────────────────────────────────────────
//  mythos-router :: skill-learning.ts
//  Self-Improving Skills — derive SKILL.md rules from past corrections
// ─────────────────────────────────────────────────────────────
//
// Every SWD receipt records the verified outcome of each file action a model
// (or external agent) claimed. When the same *kind* of claim fails verification
// across multiple runs, that is a learnable pattern: the model keeps making the
// same mistake in this repo. This module reads receipts, classifies the
// recurring failures, and proposes plain-language SKILL.md rules that steer the
// model away from them next time.
//
// Design mirrors `policy-suggestions.ts`: the analysis is a pure function over
// already-loaded receipts (so it is deterministic and unit-testable with no
// I/O), and the result is *advisory*. Nothing is written unless the caller
// explicitly opts in — see `mythos skills suggest --write`.

import type { SWDReceipt, ReceiptFileResult } from './receipts.js';

export const DEFAULT_LEARNED_SKILL_NAME = 'mythos-learned';
export const DEFAULT_MIN_OCCURRENCES = 2;

/** Coarse classification of a verification failure, used to group recurrences. */
export type FailureCategory =
  | 'content-drift'   // claimed CONTENT did not match what landed on disk
  | 'no-op-mutate'    // claimed a MUTATE that produced no change
  | 'missing-target'  // claimed to MODIFY/DELETE a file that does not exist
  | 'oversized-write' // attempted a full-file write larger than the SWD limit
  | 'other-failure';  // verification failed for a reason not otherwise classified

export interface LearnedRule {
  category: FailureCategory;
  /** The rule text, written as a SKILL.md bullet (imperative, model-facing). */
  rule: string;
  /** Why this rule is being proposed, for the human reviewer. */
  reason: string;
  /** Concrete evidence string, e.g. "3 occurrences across 2 receipts (e.g. MODIFY src/app.ts)". */
  evidence: string;
  occurrences: number;
}

export interface SkillLearningResult {
  ok: boolean;
  analyzedReceipts: number;
  failureCount: number;
  minOccurrences: number;
  skillName: string;
  rules: LearnedRule[];
  /** Proposed SKILL.md content, or null when no rule cleared the threshold. */
  skillMarkdown: string | null;
  notes: string[];
}

export interface AnalyzeOptions {
  /** A category must recur at least this many times to become a rule. Default 2. */
  minOccurrences?: number;
  /** Name of the skill the proposal would be written to. Default 'mythos-learned'. */
  skillName?: string;
}

// ── Failure classification ───────────────────────────────────

const FAILED_STATUSES = new Set(['failed', 'drift']);

/**
 * Classify a single failed/drifted file result into a coarse category.
 *
 * The detail string is produced by the SWD engine and is free-form, so this is
 * a conservative keyword heuristic — it never gates a decision on its own, it
 * only groups recurrences so a repeated pattern can surface. Unrecognized
 * details fall through to 'other-failure' rather than being force-fit.
 */
export function classifyFailure(file: ReceiptFileResult): FailureCategory {
  const detail = (file.detail ?? '').toLowerCase();
  const operation = (file.operation ?? '').toUpperCase();
  const intent = (file.intent ?? '').toUpperCase();

  if (detail.includes('exceeds') || detail.includes('large full-file') || detail.includes('too large')) {
    return 'oversized-write';
  }
  if (
    detail.includes('does not exist') ||
    detail.includes('not found') ||
    detail.includes('missing') ||
    detail.includes('no such file')
  ) {
    return 'missing-target';
  }
  if (
    intent === 'MUTATE' &&
    (detail.includes('no change') || detail.includes('unchanged') || detail.includes('identical') || file.status === 'noop')
  ) {
    return 'no-op-mutate';
  }
  if (
    detail.includes('hash') ||
    detail.includes('mismatch') ||
    detail.includes('content') ||
    detail.includes('drift') ||
    file.status === 'drift' ||
    operation === 'MODIFY' ||
    operation === 'CREATE'
  ) {
    return 'content-drift';
  }
  return 'other-failure';
}

const RULE_TEMPLATES: Record<FailureCategory, { rule: string; reason: string }> = {
  'content-drift': {
    rule:
      'When you claim CREATE or MODIFY, the CONTENT block must be the exact, complete final file. ' +
      'Do not abbreviate, summarize, or use placeholders — SWD verifies the written file byte-for-byte.',
    reason: 'Claimed file contents repeatedly failed to match what landed on disk (content drift / hash mismatch).',
  },
  'no-op-mutate': {
    rule:
      'Only mark an action INTENT: MUTATE when it actually changes the file. ' +
      'If the file is already in the desired state, use INTENT: NOOP so verification does not fail.',
    reason: 'Actions declared as MUTATE repeatedly produced no change, failing intent verification.',
  },
  'missing-target': {
    rule:
      'Before MODIFY or DELETE, confirm the target file exists. ' +
      'If you are not certain it is present, READ it first or use CREATE instead of MODIFY.',
    reason: 'MODIFY/DELETE actions repeatedly targeted files that did not exist.',
  },
  'oversized-write': {
    rule:
      'Avoid rewriting very large files in a single full-file CONTENT block. ' +
      'Split the change into smaller, focused edits that stay under the SWD write-size limit.',
    reason: 'Full-file writes repeatedly exceeded the SWD maximum write size and were blocked.',
  },
  'other-failure': {
    rule:
      'Re-check each file action against the actual filesystem state before claiming it; ' +
      'state any uncertainty explicitly rather than asserting an operation succeeded.',
    reason: 'File actions repeatedly failed verification for assorted reasons.',
  },
};

interface CategoryAccumulator {
  occurrences: number;
  receiptIds: Set<string>;
  example?: string;
}

/**
 * Analyze a set of receipts and propose SKILL.md rules for recurring failures.
 * Pure: does not touch the filesystem. Order of `receipts` does not affect the
 * result other than which concrete action is shown as the example.
 */
export function analyzeReceiptsForSkill(
  receipts: SWDReceipt[],
  options: AnalyzeOptions = {},
): SkillLearningResult {
  const minOccurrences = Math.max(1, Math.floor(options.minOccurrences ?? DEFAULT_MIN_OCCURRENCES));
  const skillName = options.skillName?.trim() || DEFAULT_LEARNED_SKILL_NAME;

  const byCategory = new Map<FailureCategory, CategoryAccumulator>();
  let failureCount = 0;

  for (const receipt of receipts) {
    const files = Array.isArray(receipt.files) ? receipt.files : [];
    for (const file of files) {
      if (!FAILED_STATUSES.has(String(file.status))) continue;
      failureCount += 1;

      const category = classifyFailure(file);
      const acc = byCategory.get(category) ?? { occurrences: 0, receiptIds: new Set<string>() };
      acc.occurrences += 1;
      acc.receiptIds.add(receipt.id);
      if (!acc.example) {
        acc.example = `${file.operation} ${file.path}`.trim();
      }
      byCategory.set(category, acc);
    }
  }

  const rules: LearnedRule[] = [];
  for (const [category, acc] of byCategory) {
    if (acc.occurrences < minOccurrences) continue;
    const template = RULE_TEMPLATES[category];
    const receiptCount = acc.receiptIds.size;
    const example = acc.example ? ` (e.g. ${acc.example})` : '';
    rules.push({
      category,
      rule: template.rule,
      reason: template.reason,
      evidence: `${acc.occurrences} occurrence(s) across ${receiptCount} receipt(s)${example}`,
      occurrences: acc.occurrences,
    });
  }

  // Deterministic ordering: most frequent first, then category name for ties.
  rules.sort((a, b) => b.occurrences - a.occurrences || a.category.localeCompare(b.category));

  const skillMarkdown = rules.length > 0 ? renderLearnedSkill(skillName, rules, receipts.length) : null;

  return {
    ok: true,
    analyzedReceipts: receipts.length,
    failureCount,
    minOccurrences,
    skillName,
    rules,
    skillMarkdown,
    notes: buildNotes(receipts.length, failureCount, rules.length, minOccurrences),
  };
}

function buildNotes(
  analyzed: number,
  failures: number,
  ruleCount: number,
  minOccurrences: number,
): string[] {
  const notes: string[] = [];
  if (analyzed === 0) {
    notes.push('No receipts found yet. Run `mythos run`/`mythos chat` so SWD can record verified outcomes to learn from.');
    return notes;
  }
  if (failures === 0) {
    notes.push('No failed or drifted file actions found in the analyzed receipts — nothing to learn from yet.');
    return notes;
  }
  if (ruleCount === 0) {
    notes.push(`Failures were found, but none recurred ${minOccurrences}+ times. Lower the threshold with --min-occurrences to see weaker patterns.`);
  }
  notes.push('Suggestions are advisory and printed only; re-run with --write to create the skill, then load it with `-s ' + DEFAULT_LEARNED_SKILL_NAME + '`.');
  notes.push('Review every rule before writing it — these are heuristics derived from past failures, not guarantees.');
  return notes;
}

/**
 * Render a complete SKILL.md document for the learned rules. Frontmatter
 * matches the house style used by `createSkill`'s template so the file parses
 * and validates the same way a hand-authored skill does.
 */
export function renderLearnedSkill(
  skillName: string,
  rules: LearnedRule[],
  receiptCount: number,
): string {
  const ruleLines = rules.map((r) => `- ${r.rule}`).join('\n');
  const evidenceLines = rules.map((r) => `- **${r.category}** — ${r.evidence}`).join('\n');
  const generatedAt = new Date().toISOString();

  return `---
name: ${skillName}
version: 0.1.0
description: Auto-derived operating rules learned from recurring SWD verification failures in this repo.
priority: 60
budget-multiplier: 1.0
allow-fallback: true
---

# ${skillName} Skill

> Generated by \`mythos skills suggest --write\` from ${receiptCount} receipt(s) on ${generatedAt}.
> These rules are derived from file actions that repeatedly failed Strict Write
> Discipline verification. Edit or prune them freely — they are a starting point,
> not a contract.

## Purpose
Prevent the recurring mistakes SWD has already caught in this repository from
happening again, by reminding the model of them before it edits files.

## Rules
${ruleLines}

## Evidence
${evidenceLines}

## Verification
- Let SWD verify every file claim before considering the task complete.
- Prefer small, reviewable changes over large full-file rewrites.
`;
}
