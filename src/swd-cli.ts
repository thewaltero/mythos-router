// ─────────────────────────────────────────────────────────────
//  mythos-router :: swd-cli.ts
//  SWD Terminal Presentation Layer (separated from kernel)
// ─────────────────────────────────────────────────────────────

import { c, dryRunBadge, verboseBadge, confirmPrompt, theme, icon } from './utils.js';
import { renderDiff } from './diff.js';
import { parseActions, snapshotFile, type FileAction, type SWDRunResult } from './swd.js';

// ── Print verification results to terminal ───────────────────
export function printSWDResults(result: SWDRunResult): void {
  if (result.results.length === 0) return;
  console.log(`\n${theme.muted}── SWD Verification ──${c.reset}`);
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
  if (result.rolledBack) {
    console.log(`\n${theme.warning}${icon.rollback} TRANSACTION ROLLBACK${c.reset}`);
    console.log(`  ${theme.muted}All operations reverted due to failure.${c.reset}`);
  }
}

// ── Interactive dry-run preview with diffs ────────────────────
export async function dryRunSWD(actions: FileAction[]): Promise<{ accepted: FileAction[], rejected: FileAction[] }> {
  if (actions.length === 0) return { accepted: [], rejected: [] };
  console.log(`\n${dryRunBadge()} ${c.bold}── File Action Preview ──${c.reset}\n`);
  const accepted: FileAction[] = [];
  const rejected: FileAction[] = [];
  for (let i = 0; i < actions.length; i++) {
    const action = actions[i]!;
    const snap = snapshotFile(action.path);
    console.log(`  ${c.bold}${i + 1}/${actions.length}${c.reset} ${c.cyan}${action.operation}${c.reset} ${action.path}`);
    console.log(`  ${c.dim}Intent: ${action.intent} | ${action.description}${c.reset}`);
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
