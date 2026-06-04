// ─────────────────────────────────────────────────────────────
//  mythos-router :: swd.ts
//  Strict Write Discipline — Production API (v1)
// ─────────────────────────────────────────────────────────────

import { readFileSync, writeFileSync, statSync, existsSync, unlinkSync, realpathSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, relative, isAbsolute, dirname, basename } from 'node:path';

// ── Public Types ─────────────────────────────────────────────
export type ActionIntent = 'MUTATE' | 'NOOP' | 'UNKNOWN';

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
  before?: FileSnapshotSummary;
  after?: FileSnapshotSummary;
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
  /**
   * Maximum size (bytes) of an existing file that MODIFY/DELETE may target.
   * The original content is held in memory to enable rollback, so oversized
   * targets are blocked fail-closed instead of risking memory pressure.
   * Defaults to MAX_ROLLBACK_SNAPSHOT_BYTES. Raise it only when you knowingly
   * mutate large files and have the memory headroom.
   */
  maxSnapshotBytes?: number;
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

export interface FileSnapshotSummary {
  path: string;
  exists: boolean;
  size: number;
  mtime: number;
  hash: string;
}


export const MAX_WRITABLE_ACTION_CONTENT_BYTES = 200_000;

// Existing files larger than this are refused for MODIFY/DELETE because their
// original content would have to be held in memory for rollback. Generous
// enough that ordinary source files never hit it.
export const MAX_ROLLBACK_SNAPSHOT_BYTES = 50_000_000;

/** Size of an existing file in bytes, or 0 if missing/unreadable. */
function existingFileSize(unsafePath: string): number {
  try {
    const abs = resolveSafePath(unsafePath);
    if (!existsSync(abs)) return 0;
    return statSync(abs).size;
  } catch {
    // Path errors are surfaced later by executeAction; treat as non-blocking here.
    return 0;
  }
}

function getWritableActionContentBytes(action: FileAction): number {
  if (!['CREATE', 'MODIFY'].includes(action.operation) || action.content === undefined) return 0;
  return Buffer.byteLength(action.content, 'utf8');
}

function largeWriteBlockedMessage(action: FileAction, bytes: number): string {
  return `Large full-file writes are blocked for ${action.path}: ${bytes} bytes exceeds ${MAX_WRITABLE_ACTION_CONTENT_BYTES}. Split the change into smaller edits.`;
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
      maxSnapshotBytes: options.maxSnapshotBytes ?? MAX_ROLLBACK_SNAPSHOT_BYTES,
      onAction: options.onAction ?? (() => {}),
      onVerify: options.onVerify ?? (() => {}),
      onRollback: options.onRollback ?? (() => {}),
    };
  }

  public async run(actions: FileAction[]): Promise<SWDRunResult> {
    if (actions.length === 0) {
      return { success: true, results: [], rolledBack: false, rollbackErrors: [], errors: [] };
    }

    const largeWriteFailures = actions
      .map(action => ({ action, bytes: getWritableActionContentBytes(action) }))
      .filter(({ bytes }) => bytes > MAX_WRITABLE_ACTION_CONTENT_BYTES)
      .map(({ action, bytes }) => ({
        action,
        status: 'failed' as VerificationStatus,
        detail: largeWriteBlockedMessage(action, bytes),
      }));

    if (largeWriteFailures.length > 0) {
      return {
        success: false,
        results: largeWriteFailures,
        rolledBack: false,
        rollbackErrors: [],
        errors: largeWriteFailures.map(r => r.detail),
      };
    }

    // Preflight: block MODIFY/DELETE of existing files too large to snapshot
    // for rollback. We only stat() here (no content read), so an oversized
    // target is never loaded into memory.
    const oversizedSnapshotFailures = actions
      .filter(action => action.operation === 'MODIFY' || action.operation === 'DELETE')
      .map(action => ({ action, size: existingFileSize(action.path) }))
      .filter(({ size }) => size > this.options.maxSnapshotBytes)
      .map(({ action, size }) => ({
        action,
        status: 'failed' as VerificationStatus,
        detail:
          `Refusing to ${action.operation} ${action.path}: existing file is ${size} bytes, ` +
          `exceeding the rollback snapshot cap of ${this.options.maxSnapshotBytes}. ` +
          `Large files can't be safely held in memory for rollback.`,
      }));

    if (oversizedSnapshotFailures.length > 0) {
      return {
        success: false,
        results: oversizedSnapshotFailures,
        rolledBack: false,
        rollbackErrors: [],
        errors: oversizedSnapshotFailures.map(r => r.detail),
      };
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
      // A throw here (e.g. ENOENT, CREATE-on-existing, permission error) must
      // NOT bypass rollback. We capture the failure, stop executing further
      // actions, and fall through to the rollback stage so any writes that
      // already succeeded in this batch are reverted.
      let executionError: string | null = null;
      if (!this.options.dryRun) {
        for (const action of actions) {
          this.options.onAction(action);
          try {
            this.executeAction(action);
            context.logExecution(action);
          } catch (err: any) {
            executionError = err instanceof Error ? err.message : String(err);
            overallSuccess = false;
            const failed: ActionResult = {
              action,
              status: 'failed',
              detail: executionError,
              before: summarizeSnapshot(context.getSnapshot(action.path, 'before')),
            };
            results.push(failed);
            this.options.onVerify(failed);
            break;
          }
        }
      }

      // 3. SNAPSHOT_AFTER + VERIFY
      // Skipped when execution already threw — there is nothing more to verify,
      // and the partially-applied batch is about to be rolled back.
      if (!executionError) {
        for (const action of actions) {
          // In dry run, we cannot verify filesystem outcomes.
          if (this.options.dryRun) {
            const res: ActionResult = {
              action,
              status: 'verified',
              detail: `Dry-run: planned ${action.operation} ${action.path} (not applied)`
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
          if (existsSync(absPath)) {
            throw new Error(`CREATE failed: file already exists at ${action.path}`);
          }
          if (action.content !== undefined) {
            // Ensure the parent directory exists so CREATE can target a new
            // subdirectory. This mirrors the sandbox apply path and keeps the
            // isolated-check gate equivalent to the real apply.
            mkdirSync(dirname(absPath), { recursive: true });
            writeFileSync(absPath, action.content);
          }
          break;
        case 'MODIFY':
          if (!existsSync(absPath)) {
            throw new Error(`MODIFY failed: file does not exist at ${action.path}`);
          }
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
    const result = (status: VerificationStatus, detail: string): ActionResult => ({
      action,
      status,
      detail,
      before: summarizeSnapshot(before),
      after: summarizeSnapshot(after),
    });

    switch (action.operation) {
      case 'CREATE':
        if (!after.exists) return result('failed', `File was not created: ${action.path}`);
        if (before.exists) return result('drift', `File already existed before CREATE: ${action.path}`);
        break;
      case 'MODIFY':
        if (!after.exists) return result('failed', `File missing after MODIFY: ${action.path}`);
        break;
      case 'DELETE':
        if (!before.exists) return result('drift', `DELETE on non-existent file: ${action.path}`);
        if (after.exists) return result('failed', `File still exists after DELETE: ${action.path}`);
        break;
    }

    // Content integrity — the authoritative SWD check.
    // When content is inlined (always the case for the built-in agent), SWD
    // computes the SHA-256 itself from the intended content and verifies the
    // bytes on disk match. SWD never trusts a caller- or model-declared hash
    // here: a language model cannot compute a real SHA-256 of its own output,
    // so the hash is derived from ground truth, not believed.
    if (action.content !== undefined && ['CREATE', 'MODIFY'].includes(action.operation)) {
      const expectedHash = createHash('sha256').update(action.content).digest('hex');
      if (after.hash !== expectedHash) {
        return result(
          'drift',
          `Written content does not match intended content for ${action.path}: expected ${expectedHash.slice(0, 12)}…, got ${after.hash.slice(0, 12)}…`,
        );
      }
    } else if (action.contentHash && after.hash !== action.contentHash) {
      // Fallback for actions that do NOT inline content: an external agent
      // may instead assert the expected post-write state by SHA-256 (e.g.
      // `mythos swd apply` with a precomputed hash). Only enforced when the
      // caller supplied a real hash and no content to verify against.
      return result(
        'drift',
        `Hash mismatch on ${action.path}: expected ${action.contentHash}, got ${after.hash}`,
      );
    }

    return result(
      changed ? 'verified' : 'noop',
      changed ? `Verified: ${action.operation} ${action.path}` : `No-op: ${action.path} remains identical.`,
    );
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
      const after = ctx.getCachedAfterSnapshot(action.path);
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

    // 'before' snapshots are memoized — we always want the original pre-run state.
    if (type === 'before') {
      if (this.snapshots.before.has(absPath)) return this.snapshots.before.get(absPath)!;
      const snap = snapshotFile(absPath);
      this.snapshots.before.set(absPath, snap);
      if (!this.logs.rollbackMap.has(absPath)) this.logs.rollbackMap.set(absPath, snap);
      return snap;
    }

    // 'after' snapshots always re-read disk state. If two actions touch the same
    // file in one run, the second verification must see the latest disk reality.
    const snap = snapshotFile(absPath);
    this.snapshots.after.set(absPath, snap);
    return snap;
  }

  public logExecution(action: FileAction): void { this.logs.executionOrder.push(action); }

  public getCachedAfterSnapshot(path: string): FileSnapshot {
    const absPath = resolveSafePath(path);
    return this.snapshots.after.get(absPath) ?? this.getSnapshot(path, 'after');
  }
}

export function resolveSafePath(unsafePath: string): string {
  const cwd = process.cwd();
  const absPath = resolve(cwd, unsafePath);
  
  let realPath = absPath;
  try {
    realPath = realpathSync(absPath);
  } catch (e: any) {
    if (e.code === 'ENOENT') {
      const parentDir = dirname(absPath);
      try {
        realPath = resolve(realpathSync(parentDir), basename(absPath));
      } catch {
        // Fallback if parent also doesn't exist
      }
    }
  }

  const relPath = relative(cwd, realPath);
  if (relPath.startsWith('..') || isAbsolute(relPath)) {
    throw new Error(`SECURITY VIOLATION: Path traversal detected on '${unsafePath}'.`);
  }
  return realPath;
}

export function snapshotFile(safeAbsPath: string): FileSnapshot {
  try {
    if (!existsSync(safeAbsPath)) return { path: safeAbsPath, exists: false, size: 0, mtime: 0, hash: '', content: null };
    const stat = statSync(safeAbsPath);
    const content = readFileSync(safeAbsPath);
    const hash = createHash('sha256').update(content).digest('hex');
    return { path: safeAbsPath, exists: true, size: stat.size, mtime: stat.mtimeMs, hash, content };
  } catch (err: any) {
    if (err.code === 'ENOENT') {
      return { path: safeAbsPath, exists: false, size: 0, mtime: 0, hash: '', content: null };
    }
    throw new Error(`Failed to snapshot file ${safeAbsPath}: ${err.message}`);
  }
}

function summarizeSnapshot(snapshot: FileSnapshot): FileSnapshotSummary {
  return {
    path: snapshot.path,
    exists: snapshot.exists,
    size: snapshot.size,
    mtime: snapshot.mtime,
    hash: snapshot.hash,
  };
}

export function parseActions(output: string): FileAction[] {
  const actions: FileAction[] = [];
  let cursor = 0;
  const START_TAG = '[FILE_ACTION:';
  const END_TAG = '[/FILE_ACTION]';

  const MAX_ACTION_BLOCK_CHARS = 250_000;

  while (true) {
    const startIdx = output.indexOf(START_TAG, cursor);
    if (startIdx === -1) break;

    const endIdx = output.indexOf(END_TAG, startIdx);
    if (endIdx === -1) {
      break;
    }

    if (endIdx - startIdx > MAX_ACTION_BLOCK_CHARS) {
      cursor = endIdx + END_TAG.length;
      continue;
    }

    const block = output.slice(startIdx, endIdx + END_TAG.length);
    cursor = endIdx + END_TAG.length;

    const lines = block.split(/\r?\n/).map(l => l.trim());
    
    // 1. Extract Path from the start tag line
    const firstLine = lines[0] || '';
    const pathEndIdx = firstLine.lastIndexOf(']');
    const path = pathEndIdx !== -1 ? firstLine.slice(START_TAG.length, pathEndIdx).trim() : '';

    // 2. Extract single-line fields
    const getField = (prefix: string) => {
      const line = lines.find(l => l.toUpperCase().startsWith(prefix.toUpperCase()));
      return line ? line.slice(prefix.length).trim() : undefined;
    };

    const operation = getField('OPERATION:');
    const intent = getField('INTENT:');
    const contentHash = getField('CONTENT_HASH:');
    const description = getField('DESCRIPTION:');

    // 3. Extract multi-line Content
    let content: string | undefined;
    const contentMarker = 'CONTENT:';
    const contentStartIdx = block.indexOf(contentMarker);
    if (contentStartIdx !== -1) {
      // Content is everything between 'CONTENT:' and '[/FILE_ACTION]'
      let rawContent = block.slice(contentStartIdx + contentMarker.length, block.lastIndexOf(END_TAG));
      rawContent = rawContent.replace(/^\r?\n/, '');
      rawContent = rawContent.replace(/\r?\n$/, '');
      content = rawContent;
    }

    if (path && operation && description) {
      if (
        path.trim() === '' ||
        path.length > 500 ||
        path.includes('\0') ||
        path.includes('..') ||
        path.startsWith('/') ||
        isAbsolute(path)
      ) {
        continue;
      }

      const opUpper = operation.toUpperCase();
      if (!['CREATE', 'MODIFY', 'DELETE', 'READ'].includes(opUpper)) {
        continue;
      }

      const intentUpper = intent?.toUpperCase();
      let resolvedIntent: ActionIntent;
      if (intentUpper === 'NOOP') resolvedIntent = 'NOOP';
      else if (intentUpper === 'UNKNOWN') resolvedIntent = 'UNKNOWN';
      else if (intentUpper === 'MUTATE') resolvedIntent = 'MUTATE';
      // No explicit intent: a READ is inherently a no-op; everything else is a
      // mutation. This mirrors the JSON action normalizer and prevents a raw
      // READ block (no INTENT line) from failing as a MUTATE/noop mismatch.
      else resolvedIntent = opUpper === 'READ' ? 'NOOP' : 'MUTATE';

      actions.push({
        path,
        operation: opUpper as FileAction['operation'],
        intent: resolvedIntent,
        contentHash,
        description,
        content,
      });
    }
  }
  return actions;
}

// ── Summary Helper ───────────────────────────────────────────
export function summarizeActions(output: string, userInput: string): string {
  const actions = parseActions(output);
  return actions.length > 0 ? actions.map(a => `${a.operation}: ${a.path}`).join('; ') : `chat: ${userInput.slice(0, 80)}`;
}
