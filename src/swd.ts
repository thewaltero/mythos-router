// ─────────────────────────────────────────────────────────────
//  mythos-router :: swd.ts
//  Strict Write Discipline — Filesystem verification engine
// ─────────────────────────────────────────────────────────────

import { readFileSync, statSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { MAX_CORRECTION_RETRIES } from './config.js';
import { c, warn, error, success, dryRunBadge, verboseBadge, confirmPrompt } from './utils.js';

// ── Types ────────────────────────────────────────────────────
export interface FileSnapshot {
  path: string;
  exists: boolean;
  size: number;
  mtime: number;
  hash: string;
}

export interface FileAction {
  path: string;
  operation: 'CREATE' | 'MODIFY' | 'DELETE' | 'READ';
  contentHash?: string;
  description: string;
}

export interface SWDResult {
  verified: boolean;
  actions: FileActionVerification[];
  correctionPrompt?: string;
}

export interface FileActionVerification {
  action: FileAction;
  status: 'verified' | 'drift' | 'failed';
  detail: string;
}

export interface DryRunResult {
  actions: FileAction[];
  accepted: FileAction[];
  rejected: FileAction[];
}

// ── Snapshot a file ──────────────────────────────────────────
export function snapshotFile(filePath: string): FileSnapshot {
  const absPath = resolve(filePath);
  try {
    if (!existsSync(absPath)) {
      return { path: absPath, exists: false, size: 0, mtime: 0, hash: '' };
    }
    const stat = statSync(absPath);
    const content = readFileSync(absPath);
    const hash = createHash('sha256').update(content).digest('hex');
    return {
      path: absPath,
      exists: true,
      size: stat.size,
      mtime: stat.mtimeMs,
      hash,
    };
  } catch {
    return { path: absPath, exists: false, size: 0, mtime: 0, hash: '' };
  }
}

// ── Snapshot multiple files ──────────────────────────────────
export function snapshotFiles(paths: string[]): Map<string, FileSnapshot> {
  const map = new Map<string, FileSnapshot>();
  for (const p of paths) {
    const snap = snapshotFile(p);
    map.set(snap.path, snap);
  }
  return map;
}

// ── Parse FILE_ACTION blocks from model output ──────────────
export function parseFileActions(output: string): FileAction[] {
  const actions: FileAction[] = [];
  const regex =
    /\[FILE_ACTION:\s*(.+?)\]\s*\n\s*OPERATION:\s*(CREATE|MODIFY|DELETE|READ)\s*\n(?:\s*CONTENT_HASH:\s*(\S+)\s*\n)?\s*DESCRIPTION:\s*(.+?)\s*\n\s*\[\/FILE_ACTION\]/gi;

  let match;
  while ((match = regex.exec(output)) !== null) {
    actions.push({
      path: match[1]!.trim(),
      operation: match[2]!.trim().toUpperCase() as FileAction['operation'],
      contentHash: match[3]?.trim() || undefined,
      description: match[4]!.trim(),
    });
  }
  return actions;
}

// ── Verify a single action against filesystem ───────────────
export function verifyAction(
  action: FileAction,
  before: FileSnapshot,
  after: FileSnapshot,
): FileActionVerification {
  switch (action.operation) {
    case 'CREATE': {
      if (!after.exists) {
        return {
          action,
          status: 'failed',
          detail: `File was not created: ${action.path} (does not exist on disk)`,
        };
      }
      if (before.exists) {
        return {
          action,
          status: 'drift',
          detail: `File already existed before CREATE: ${action.path}`,
        };
      }
      if (action.contentHash && after.hash !== action.contentHash) {
        return {
          action,
          status: 'drift',
          detail: `Content hash mismatch: expected ${action.contentHash.slice(0, 12)}…, got ${after.hash.slice(0, 12)}…`,
        };
      }
      return {
        action,
        status: 'verified',
        detail: `Created: ${action.path} (${after.size} bytes)`,
      };
    }

    case 'MODIFY': {
      if (!after.exists) {
        return {
          action,
          status: 'failed',
          detail: `File does not exist after MODIFY: ${action.path}`,
        };
      }
      if (after.hash === before.hash) {
        return {
          action,
          status: 'drift',
          detail: `File unchanged after claimed MODIFY: ${action.path}`,
        };
      }
      if (action.contentHash && after.hash !== action.contentHash) {
        return {
          action,
          status: 'drift',
          detail: `Content hash mismatch after MODIFY: expected ${action.contentHash.slice(0, 12)}…, got ${after.hash.slice(0, 12)}…`,
        };
      }
      return {
        action,
        status: 'verified',
        detail: `Modified: ${action.path} (${before.size} → ${after.size} bytes)`,
      };
    }

    case 'DELETE': {
      if (after.exists) {
        return {
          action,
          status: 'failed',
          detail: `File still exists after claimed DELETE: ${action.path}`,
        };
      }
      if (!before.exists) {
        return {
          action,
          status: 'drift',
          detail: `File didn't exist before DELETE: ${action.path}`,
        };
      }
      return {
        action,
        status: 'verified',
        detail: `Deleted: ${action.path}`,
      };
    }

    case 'READ': {
      if (!after.exists) {
        return {
          action,
          status: 'failed',
          detail: `File does not exist for READ: ${action.path}`,
        };
      }
      return {
        action,
        status: 'verified',
        detail: `Read: ${action.path} (${after.size} bytes)`,
      };
    }

    default:
      return {
        action,
        status: 'drift',
        detail: `Unknown operation: ${action.operation}`,
      };
  }
}

// ── Full SWD verification pass ───────────────────────────────
export function runSWD(
  modelOutput: string,
  beforeSnapshots: Map<string, FileSnapshot>,
): SWDResult {
  const actions = parseFileActions(modelOutput);

  if (actions.length === 0) {
    return { verified: true, actions: [] };
  }

  // Take "after" snapshots for all referenced paths
  const paths = actions.map((a) => resolve(a.path));
  const afterSnapshots = snapshotFiles(paths);

  const verifications: FileActionVerification[] = [];
  let allVerified = true;

  for (const action of actions) {
    const absPath = resolve(action.path);
    const before = beforeSnapshots.get(absPath) ?? snapshotFile(absPath);
    const after = afterSnapshots.get(absPath) ?? snapshotFile(absPath);
    const result = verifyAction(action, before, after);
    verifications.push(result);
    if (result.status !== 'verified') {
      allVerified = false;
    }
  }

  // Generate correction prompt if needed
  let correctionPrompt: string | undefined;
  if (!allVerified) {
    const failures = verifications
      .filter((v) => v.status !== 'verified')
      .map(
        (v) =>
          `- [${v.status.toUpperCase()}] ${v.action.operation} ${v.action.path}: ${v.detail}`,
      )
      .join('\n');

    correctionPrompt =
      `[SWD CORRECTION TURN]\n` +
      `The following file actions failed verification:\n${failures}\n\n` +
      `Actual filesystem state:\n` +
      verifications
        .filter((v) => v.status !== 'verified')
        .map((v) => {
          const after = afterSnapshots.get(resolve(v.action.path));
          return `- ${v.action.path}: exists=${after?.exists ?? false}, size=${after?.size ?? 0}, hash=${after?.hash?.slice(0, 16) ?? 'N/A'}`;
        })
        .join('\n') +
      `\n\nPlease correct your response. You have ${MAX_CORRECTION_RETRIES} correction attempts remaining.`;
  }

  return {
    verified: allVerified,
    actions: verifications,
    correctionPrompt,
  };
}

// ── Print SWD results ────────────────────────────────────────
export function printSWDResults(result: SWDResult): void {
  if (result.actions.length === 0) return;

  console.log(`\n${c.dim}── SWD Verification ──${c.reset}`);
  for (const v of result.actions) {
    switch (v.status) {
      case 'verified':
        success(v.detail);
        break;
      case 'drift':
        warn(v.detail);
        break;
      case 'failed':
        error(v.detail);
        break;
    }
  }
}

// ── Pre-scan: snapshot files that might be affected ──────────
export function prescanPaths(modelOutput: string): string[] {
  const actions = parseFileActions(modelOutput);
  return actions.map((a) => resolve(a.path));
}

// ── Quick git-status style check for unexpected changes ──────
export function detectUnexpectedChanges(
  beforeAll: Map<string, FileSnapshot>,
  claimedPaths: Set<string>,
): string[] {
  const unexpected: string[] = [];
  for (const [path, before] of beforeAll) {
    if (claimedPaths.has(path)) continue;
    const after = snapshotFile(path);
    if (after.hash !== before.hash || after.exists !== before.exists) {
      unexpected.push(path);
    }
  }
  return unexpected;
}

// ── Dry-Run SWD — Preview actions with interactive approval ──
export async function dryRunSWD(modelOutput: string): Promise<DryRunResult> {
  const actions = parseFileActions(modelOutput);

  if (actions.length === 0) {
    console.log(`\n${dryRunBadge()} ${c.dim}No file actions detected in response.${c.reset}`);
    return { actions: [], accepted: [], rejected: [] };
  }

  console.log(`\n${dryRunBadge()} ${c.bold}── File Action Preview ──${c.reset}`);
  console.log(`${c.dim}  ${actions.length} file action(s) detected. Review each:${c.reset}\n`);

  const accepted: FileAction[] = [];
  const rejected: FileAction[] = [];

  for (let i = 0; i < actions.length; i++) {
    const action = actions[i]!;
    const absPath = resolve(action.path);
    const snap = snapshotFile(absPath);

    // Show action details
    const opColor = action.operation === 'DELETE' ? c.red :
                     action.operation === 'CREATE' ? c.green :
                     action.operation === 'MODIFY' ? c.yellow : c.cyan;

    console.log(`  ${c.bold}${i + 1}/${actions.length}${c.reset} ${opColor}${action.operation}${c.reset} ${c.cyan}${action.path}${c.reset}`);
    console.log(`  ${c.dim}Description: ${action.description}${c.reset}`);

    // Show current file state
    if (snap.exists) {
      console.log(`  ${c.dim}Current state: ${snap.size} bytes, hash: ${snap.hash.slice(0, 16)}…${c.reset}`);
    } else {
      console.log(`  ${c.dim}Current state: does not exist${c.reset}`);
    }

    if (action.contentHash) {
      console.log(`  ${c.dim}Expected hash: ${action.contentHash.slice(0, 16)}…${c.reset}`);
    }

    // Ask for confirmation
    const ok = await confirmPrompt(
      `  ${dryRunBadge()} Accept ${opColor}${action.operation}${c.reset} on ${c.cyan}${action.path}${c.reset}?`,
    );

    if (ok) {
      accepted.push(action);
      success(`  Accepted: ${action.operation} ${action.path}`);
    } else {
      rejected.push(action);
      warn(`  Rejected: ${action.operation} ${action.path}`);
    }
    console.log();
  }

  // Summary
  console.log(`${dryRunBadge()} ${c.bold}Summary:${c.reset} ` +
    `${c.green}${accepted.length} accepted${c.reset} · ` +
    `${c.red}${rejected.length} rejected${c.reset}`);

  return { actions, accepted, rejected };
}

// ── Verbose action logging ───────────────────────────────────
export function printVerboseAction(action: FileAction): void {
  const opColor = action.operation === 'DELETE' ? c.red :
                   action.operation === 'CREATE' ? c.green :
                   action.operation === 'MODIFY' ? c.yellow : c.cyan;

  console.log(`  ${verboseBadge()} ${opColor}${action.operation}${c.reset} ${c.cyan}${action.path}${c.reset}`);
  console.log(`  ${c.dim}├─ Description: ${action.description}${c.reset}`);
  if (action.contentHash) {
    console.log(`  ${c.dim}├─ Content Hash: ${action.contentHash}${c.reset}`);
  }
  const snap = snapshotFile(resolve(action.path));
  if (snap.exists) {
    console.log(`  ${c.dim}└─ Current: ${snap.size} bytes, hash=${snap.hash.slice(0, 24)}…${c.reset}`);
  } else {
    console.log(`  ${c.dim}└─ Current: does not exist${c.reset}`);
  }
}

// ── Verbose parse trace ──────────────────────────────────────
export function printVerboseParse(modelOutput: string): void {
  const actions = parseFileActions(modelOutput);
  console.log(`\n${verboseBadge()} ${c.dim}── FILE_ACTION Parse Trace ──${c.reset}`);
  console.log(`${c.dim}  Parsed ${actions.length} FILE_ACTION block(s) from model output (${modelOutput.length} chars)${c.reset}`);
  for (const action of actions) {
    printVerboseAction(action);
  }
}
