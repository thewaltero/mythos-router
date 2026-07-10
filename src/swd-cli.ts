// ─────────────────────────────────────────────────────────────
//  mythos-router :: swd-cli.ts
//  SWD Terminal Presentation Layer (separated from kernel)
// ─────────────────────────────────────────────────────────────

import { c, dryRunBadge, verboseBadge, confirmPrompt, theme, icon } from './utils.js';
import { renderDiff } from './diff.js';
import { parseActions, snapshotFile, type FileAction, type SWDRunResult } from './swd.js';
import { reviewActions } from './security-policy.js';

// ── Print verification results to terminal ───────────────────
export function printSWDResults(result: SWDRunResult): void {
  if (result.results.length === 0 && !result.rollbackStatus) return;
  console.log(`
${theme.muted}── SWD Verification ──${c.reset}`);
  for (const v of result.results) {
    const isDryRunPlan = v.detail.startsWith('Dry-run: planned ');
    const isOk = ['verified', 'noop'].includes(v.status);
    const statusIcon = isDryRunPlan
      ? `${theme.muted}${icon.thinking}`
      : isOk
        ? `${theme.success}${icon.success}`
        : `${theme.error}${icon.error}`;
    console.log(`  ${statusIcon}${c.reset} ${v.detail}`);
  }

  switch (result.rollbackStatus) {
    case 'complete':
      console.log(`
${theme.warning}${icon.rollback} TRANSACTION ROLLBACK COMPLETE${c.reset}`);
      console.log(`  ${theme.muted}All committed SWD mutations were reverted.${c.reset}`);
      break;
    case 'partial':
      console.log(`
${theme.error}${icon.rollback} TRANSACTION ROLLBACK PARTIAL${c.reset}`);
      console.log(`  ${theme.warning}Some mutations were reverted; manual recovery is required.${c.reset}`);
      break;
    case 'failed':
      console.log(`
${theme.error}${icon.rollback} TRANSACTION ROLLBACK FAILED${c.reset}`);
      console.log(`  ${theme.warning}Committed state remains; manual recovery is required.${c.reset}`);
      break;
    case 'disabled':
      console.log(`
${theme.warning}${icon.rollback} TRANSACTION ROLLBACK DISABLED${c.reset}`);
      console.log(`  ${theme.warning}Committed state was intentionally left in place.${c.reset}`);
      break;
    default:
      // Legacy SWDRunResult values may not contain rollbackStatus.
      if (result.rolledBack) {
        console.log(`
${theme.warning}${icon.rollback} TRANSACTION ROLLBACK${c.reset}`);
        console.log(`  ${theme.muted}Committed operations were reverted due to failure.${c.reset}`);
      }
  }

  for (const rollbackError of result.rollbackErrors) {
    console.log(`  ${theme.error}${icon.error}${c.reset} ${rollbackError}`);
  }
}

// ── Interactive dry-run preview with diffs ────────────────────
export async function dryRunSWD(actions: FileAction[]): Promise<{ accepted: FileAction[], rejected: FileAction[] }> {
  if (actions.length === 0) return { accepted: [], rejected: [] };
  console.log(`\n${dryRunBadge()} ${c.bold}── File Action Preview ──${c.reset}\n`);
  const accepted: FileAction[] = [];
  const rejected: FileAction[] = [];
  const review = reviewActions(actions);
  for (let i = 0; i < actions.length; i++) {
    const action = actions[i]!;
    const blocked = review.blocked.find((item) => item.action === action);
    if (blocked) {
      console.log(`  ${c.bold}${i + 1}/${actions.length}${c.reset} ${c.cyan}${action.operation}${c.reset} ${action.path}`);
      console.log(`  ${theme.error}${icon.error}${c.reset} Blocked by policy: ${blocked.verdict.reason}`);
      rejected.push(action);
      console.log();
      continue;
    }

    const needsConfirmation = review.needsConfirmation.find((item) => item.action === action);
    const snap = snapshotFile(action.path);
    console.log(`  ${c.bold}${i + 1}/${actions.length}${c.reset} ${c.cyan}${action.operation}${c.reset} ${action.path}`);
    console.log(`  ${c.dim}Intent: ${action.intent} | ${action.description}${c.reset}`);
    if (needsConfirmation) {
      console.log(`  ${theme.warning}${icon.warning}${c.reset} ${needsConfirmation.verdict.reason}`);
    }
    if (action.content && (action.operation === 'MODIFY' || action.operation === 'CREATE')) {
      const old = snap.exists && snap.content ? snap.content.toString() : '';
      console.log(renderDiff(old, action.content));
    }
    if (await confirmPrompt(`  Accept?`)) accepted.push(action); else rejected.push(action);
    console.log();
  }
  return { accepted, rejected };
}

// ── Verbose parse tracing ────────────────────────────────────
export function printVerboseAction(action: FileAction): void {
  console.log(`  ${verboseBadge()} ${c.cyan}${action.operation}${c.reset} ${action.path} (Intent: ${action.intent})`);
}

export function printVerboseParse(output: string): void {
  const actions = parseActions(output);
  console.log(`\n${verboseBadge()} ${c.dim}── Parse Trace (${actions.length}) ──${c.reset}`);
  for (const action of actions) printVerboseAction(action);
}
