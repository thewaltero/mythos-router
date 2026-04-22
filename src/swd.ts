// ─────────────────────────────────────────────────────────────
//  mythos-router :: swd.ts
//  Strict Write Discipline — Production API (v1)
// ─────────────────────────────────────────────────────────────

import { readFileSync, writeFileSync, statSync, existsSync, unlinkSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, relative, isAbsolute } from 'node:path';
import { c, warn, success, dryRunBadge, verboseBadge, confirmPrompt } from './utils.js';

// ── Public Types ─────────────────────────────────────────────
export type ActionIntent = 'MUTATE' | 'NOOP';

export interface FileAction {
  path: string;
  operation: 'CREATE' | 'MODIFY' | 'DELETE' | 'READ';
  intent: ActionIntent;
  content?: string;
  contentHash?: string;
  description?: string;
}

export type VerificationStatus =
  | 'verified' 
  | 'noop'     
  | 'failed'   
  | 'drift';    

export interface ActionResult {
  action: FileAction;
  status: VerificationStatus;
  detail: string;
}

export interface SWDRunResult {
  success: boolean;
  results: ActionResult[];
  rolledBack: boolean;
  rollbackErrors: string[]; // Added for auditability
  errors: string[];
}

export interface SWDOptions {
  dryRun?: boolean;
  strict?: boolean;
  enableRollback?: boolean;
  // Hook System for Extensibility
  onAction?: (action: FileAction) => void;
  onVerify?: (result: ActionResult) => void;
  onRollback?: (path: string, success: boolean, error?: string) => void;
}

export interface FileSnapshot {
  path: string;
  exists: boolean;
  size: number;
  mtime: number;
  hash: string;
  content: Buffer | null;
}

// ── SWD Engine ───────────────────────────────────────────────
/**
 * Authoritative filesystem execution kernel.
 * Lifecycle: Plan → Snapshot_Before → Execute → Snapshot_After → Verify → Commit/Rollback
 */
export class SWDEngine {
  private options: Required<SWDOptions>;

  constructor(options: SWDOptions = {}) {
    this.options = {
      dryRun: options.dryRun ?? false,
      strict: options.strict ?? true,
      enableRollback: options.enableRollback ?? true,
      onAction: options.onAction ?? (() => {}),
      onVerify: options.onVerify ?? (() => {}),
      onRollback: options.onRollback ?? (() => {}),
    };
  }

  public async run(actions: FileAction[]): Promise<SWDRunResult> {
    if (actions.length === 0) {
      return { success: true, results: [], rolledBack: false, rollbackErrors: [], errors: [] };
    }

    const context = new InternalSessionContext();
    const results: ActionResult[] = [];
    const rollbackErrors: string[] = [];
    let overallSuccess = true;

    try {
      // 1. PLAN + SNAPSHOT_BEFORE
      for (const action of actions) {
        context.getSnapshot(action.path, 'before');
      }

      // 2. EXECUTE
      if (!this.options.dryRun) {
        for (const action of actions) {
          this.options.onAction(action);
          this.executeAction(action);
          context.logExecution(action);
        }
      }

      // 3. SNAPSHOT_AFTER + VERIFY
      for (const action of actions) {
        // In dry run, we cannot verify filesystem outcomes.
        if (this.options.dryRun) {
          const res: ActionResult = {
            action,
            status: 'verified',
            detail: `Dry-run: ${action.operation} ${action.path} (not applied)`
          };
          results.push(res);
          this.options.onVerify(res);
          continue;
        }

        const verification = this.verifyInternal(action, context);
        
        // Intent reinforcement
        if (action.intent === 'MUTATE' && verification.status === 'noop') {
          verification.status = 'failed';
          verification.detail = `Intent mismatch: Expected mutation on ${action.path} but file remained identical.`;
        }

        results.push(verification);
        this.options.onVerify(verification);

        if (verification.status === 'failed' || (this.options.strict && verification.status === 'drift')) {
          overallSuccess = false;
        }
      }

      // 4. ROLLBACK
      let rolledBack = false;
      if (!overallSuccess && this.options.enableRollback && !this.options.dryRun) {
        const rbResult = this.performRollback(context);
        rolledBack = rbResult.anyRolledBack;
        rollbackErrors.push(...rbResult.errors);
      }

      return {
        success: overallSuccess,
        results,
        rolledBack,
        rollbackErrors,
        errors: results.filter(r => ['failed', 'drift'].includes(r.status)).map(r => r.detail),
      };

    } catch (err: any) {
      return { success: false, results, rolledBack: false, rollbackErrors, errors: [err.message] };
    }
  }

  private executeAction(action: FileAction): void {
    const absPath = resolveSafePath(action.path);
    try {
      switch (action.operation) {
        case 'CREATE':
        case 'MODIFY':
          if (action.content !== undefined) writeFileSync(absPath, action.content);
          break;
        case 'DELETE':
          if (existsSync(absPath)) unlinkSync(absPath);
          break;
        case 'READ': break;
      }
    } catch (e: any) {
      throw new Error(`Execution failed for ${action.path}: ${e.message}`);
    }
  }

  private verifyInternal(action: FileAction, ctx: InternalSessionContext): ActionResult {
    const before = ctx.getSnapshot(action.path, 'before');
    const after = ctx.getSnapshot(action.path, 'after');
    const changed = after.hash !== before.hash;

    switch (action.operation) {
      case 'CREATE':
        if (!after.exists) return { action, status: 'failed', detail: `File was not created: ${action.path}` };
        if (before.exists) return { action, status: 'drift', detail: `File already existed before CREATE: ${action.path}` };
        break;
      case 'MODIFY':
        if (!after.exists) return { action, status: 'failed', detail: `File missing after MODIFY: ${action.path}` };
        break;
      case 'DELETE':
        if (after.exists) return { action, status: 'failed', detail: `File still exists after DELETE: ${action.path}` };
        break;
    }

    if (action.contentHash && after.hash !== action.contentHash) {
      return { action, status: 'drift', detail: `Hash mismatch on ${action.path}: expected ${action.contentHash.slice(0, 12)}, got ${after.hash.slice(0, 12)}` };
    }

    return {
      action,
      status: changed ? 'verified' : 'noop',
      detail: changed ? `Verified: ${action.operation} ${action.path}` : `No-op: ${action.path} remains identical.`,
    };
  }

  private performRollback(ctx: InternalSessionContext): { anyRolledBack: boolean, errors: string[] } {
    const revOrder = [...ctx.logs.executionOrder].reverse();
    const seenPaths = new Set<string>();
    const errors: string[] = [];
    let anyRolledBack = false;

    for (const action of revOrder) {
      if (seenPaths.has(action.path)) continue;
      const absPath = resolveSafePath(action.path);
      const original = ctx.logs.rollbackMap.get(absPath);
      const after = ctx.getSnapshot(action.path, 'after');
      const current = snapshotFile(absPath);

      if (!original) continue;

      if (current.hash === after.hash && current.exists === after.exists) {
        try {
          if (original.exists && original.content !== null) {
            writeFileSync(absPath, original.content);
          } else if (existsSync(absPath)) {
            unlinkSync(absPath);
          }
          anyRolledBack = true;
          seenPaths.add(action.path);
          this.options.onRollback(action.path, true);
        } catch (e: any) { 
          const msg = `Rollback failed for ${action.path}: ${e.message}`;
          errors.push(msg);
          this.options.onRollback(action.path, false, e.message);
        }
      } else {
        const msg = `Concurrency Drift: Skipping rollback for ${action.path}`;
        errors.push(msg);
        this.options.onRollback(action.path, false, 'Concurrency drift detected');
      }
    }
    return { anyRolledBack, errors };
  }
}

// ── Internal Helpers ─────────────────────────────────────────
class InternalSessionContext {
  public snapshots = { before: new Map<string, FileSnapshot>(), after: new Map<string, FileSnapshot>() };
  public logs = { executionOrder: [] as FileAction[], rollbackMap: new Map<string, FileSnapshot>() };

  public getSnapshot(path: string, type: 'before' | 'after'): FileSnapshot {
    const absPath = resolveSafePath(path);
    const registry = type === 'before' ? this.snapshots.before : this.snapshots.after;
    if (registry.has(absPath)) return registry.get(absPath)!;
    const snap = snapshotFile(absPath);
    registry.set(absPath, snap);
    if (type === 'before' && !this.logs.rollbackMap.has(absPath)) this.logs.rollbackMap.set(absPath, snap);
    return snap;
  }

  public logExecution(action: FileAction): void { this.logs.executionOrder.push(action); }
}

export function resolveSafePath(unsafePath: string): string {
  const cwd = process.cwd();
  const absPath = resolve(cwd, unsafePath);
  const relPath = relative(cwd, absPath);
  if (relPath.startsWith('..') || isAbsolute(relPath)) {
    throw new Error(`SECURITY VIOLATION: Path traversal detected on '${unsafePath}'.`);
  }
  return absPath;
}

export function snapshotFile(filePath: string): FileSnapshot {
  const absPath = resolveSafePath(filePath); 
  try {
    if (!existsSync(absPath)) return { path: absPath, exists: false, size: 0, mtime: 0, hash: '', content: null };
    const stat = statSync(absPath);
    const content = readFileSync(absPath);
    const hash = createHash('sha256').update(content).digest('hex');
    return { path: absPath, exists: true, size: stat.size, mtime: stat.mtimeMs, hash, content };
  } catch {
    return { path: absPath, exists: false, size: 0, mtime: 0, hash: '', content: null };
  }
}

export function parseActions(output: string): FileAction[] {
  const actions: FileAction[] = [];
  const regex = /\[FILE_ACTION:\s*(.+?)\]\s*\n\s*OPERATION:\s*(CREATE|MODIFY|DELETE|READ)\s*\n(?:\s*INTENT:\s*(MUTATE|NOOP)\s*\n)?(?:\s*CONTENT_HASH:\s*(\S+)\s*\n)?\s*DESCRIPTION:\s*(.+?)\s*\n(?:\s*CONTENT:\s*([\s\S]*?)\s*\n)?\s*\[\/FILE_ACTION\]/gi;
  let match;
  while ((match = regex.exec(output)) !== null) {
    actions.push({
      path: match[1]!.trim(),
      operation: match[2]!.trim().toUpperCase() as FileAction['operation'],
      intent: (match[3]?.trim().toUpperCase() || 'MUTATE') as ActionIntent,
      contentHash: match[4]?.trim() || undefined,
      description: match[5]!.trim(),
      content: match[6]?.trim() || undefined,
    });
  }
  return actions;
}

// ── CLI Compatibility ────────────────────────────────────────
export function printSWDResults(result: SWDRunResult): void {
  if (result.results.length === 0) return;
  console.log(`\n${c.dim}── SWD Verification ──${c.reset}`);
  for (const v of result.results) {
    const icon = ['verified', 'noop'].includes(v.status) ? c.green : c.red;
    console.log(`  ${icon}•${c.reset} ${v.detail}`);
  }
  if (result.rolledBack) {
    console.log(`\n${c.bgYellow}${c.black}${c.bold} TRANSACTION ROLLBACK ${c.reset}`);
    console.log(`  ${c.yellow}⟲${c.reset} All operations reverted due to failure.`);
  }
}

import { renderDiff } from './diff.js';
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

export function printVerboseAction(action: FileAction): void {
  console.log(`  ${verboseBadge()} ${c.cyan}${action.operation}${c.reset} ${action.path} (Intent: ${action.intent})`);
}

export function printVerboseParse(output: string): void {
  const actions = parseActions(output);
  console.log(`\n${verboseBadge()} ${c.dim}── Parse Trace (${actions.length}) ──${c.reset}`);
  for (const action of actions) printVerboseAction(action);
}

// ── Summary Helper ───────────────────────────────────────────
export function summarizeActions(output: string, userInput: string): string {
  const actions = parseActions(output);
  return actions.length > 0 ? actions.map(a => `${a.operation}: ${a.path}`).join('; ') : `chat: ${userInput.slice(0, 80)}`;
}
