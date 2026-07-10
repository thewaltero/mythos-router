// ─────────────────────────────────────────────────────────────
//  mythos-router :: swd.ts
//  Strict Write Discipline — Production API (v1)
// ─────────────────────────────────────────────────────────────

import { readFileSync, statSync, existsSync, unlinkSync, rmdirSync, openSync, readSync, closeSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { isSafeRelativePathShape } from './path-safety.js';
import { PathJail } from './path-jail.js';
import { AtomicFileWriter } from './atomic-writer.js';

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

export type SWDRollbackStatus =
  | 'not-needed'
  | 'disabled'
  | 'complete'
  | 'partial'
  | 'failed';

export interface SWDRunResult {
  success: boolean;
  results: ActionResult[];
  /** Backwards-compatible flag: true when at least one mutation or directory was restored. */
  rolledBack: boolean;
  rollbackErrors: string[];
  /** Detailed rollback outcome emitted by SWDEngine. Optional for legacy serialized results. */
  rollbackStatus?: SWDRollbackStatus;
  /** True when committed filesystem state may require manual inspection or recovery. */
  recoveryRequired?: boolean;
  errors: string[];
}

export interface SWDOptions {
  /**
   * Canonical repository root for every action in this engine instance.
   * Captured when the engine is constructed so later process.cwd() changes do
   * not silently move the filesystem boundary.
   */
  rootDir?: string;
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
  /** Permission bits captured for atomic replacement and rollback. */
  mode: number | null;
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
function existingFileSize(pathJail: PathJail, unsafePath: string): number {
  try {
    const abs = pathJail.resolve(unsafePath);
    if (!existsSync(abs)) return 0;
    return statSync(abs).size;
  } catch {
    // Path validation runs before this size check. Other stat failures are
    // surfaced by the snapshot stage before any mutation occurs.
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
  private options: Required<Omit<SWDOptions, 'rootDir'>>;
  private readonly pathJail: PathJail;
  private readonly atomicWriter = new AtomicFileWriter();

  constructor(options: SWDOptions = {}) {
    this.pathJail = new PathJail(options.rootDir ?? process.cwd());
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
      return {
        success: true,
        results: [],
        rolledBack: false,
        rollbackErrors: [],
        rollbackStatus: 'not-needed',
        recoveryRequired: false,
        errors: [],
      };
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
        rollbackStatus: 'not-needed',
        recoveryRequired: false,
        errors: largeWriteFailures.map(r => r.detail),
      };
    }

    const pathFailures = this.validateActionPaths(actions);
    if (pathFailures.length > 0) {
      return {
        success: false,
        results: pathFailures,
        rolledBack: false,
        rollbackErrors: [],
        rollbackStatus: 'not-needed',
        recoveryRequired: false,
        errors: pathFailures.map(result => result.detail),
      };
    }

    // Preflight: block MODIFY/DELETE of existing files too large to snapshot
    // for rollback. We only stat() here (no content read), so an oversized
    // target is never loaded into memory.
    const oversizedSnapshotFailures = actions
      .filter(action => action.operation === 'MODIFY' || action.operation === 'DELETE')
      .map(action => ({ action, size: existingFileSize(this.pathJail, action.path) }))
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
        rollbackStatus: 'not-needed',
        recoveryRequired: false,
        errors: oversizedSnapshotFailures.map(r => r.detail),
      };
    }

    const context = new InternalSessionContext(this.pathJail, this.options.maxSnapshotBytes);
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
            this.executeAction(action, context);
          } catch (err: any) {
            executionError = err instanceof Error ? err.message : String(err);
            overallSuccess = false;

            // Audit completeness: actions that already executed in this batch
            // are about to be rolled back without ever reaching verification.
            // Record them explicitly so receipts reflect everything that
            // touched the disk, not just the action that failed.
            for (const applied of context.logs.executionOrder) {
              const aborted: ActionResult = {
                action: applied,
                status: 'failed',
                detail: `Applied but not verified: batch aborted after failure of ${action.path}; rollback attempted.`,
                before: summarizeSnapshot(context.getSnapshot(applied.path, 'before')),
              };
              results.push(aborted);
              this.options.onVerify(aborted);
            }

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
      const rollback = this.resolveRollbackOutcome(overallSuccess, context);
      rollbackErrors.push(...rollback.errors);

      return {
        success: overallSuccess,
        results,
        rolledBack: rollback.anyRolledBack,
        rollbackErrors,
        rollbackStatus: rollback.status,
        recoveryRequired: rollback.recoveryRequired,
        errors: results.filter(r => ['failed', 'drift'].includes(r.status)).map(r => r.detail),
      };

    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.appendUnverifiedExecutionResults(context, results, message);

      const rollback = this.resolveRollbackOutcome(false, context);
      rollbackErrors.push(...rollback.errors);

      const resultErrors = results
        .filter(result => result.status === 'failed' || result.status === 'drift')
        .map(result => result.detail);

      return {
        success: false,
        results,
        rolledBack: rollback.anyRolledBack,
        rollbackErrors,
        rollbackStatus: rollback.status,
        recoveryRequired: rollback.recoveryRequired,
        errors: [...new Set([...resultErrors, message])],
      };
    }
  }

  private validateActionPaths(actions: FileAction[]): ActionResult[] {
    const failures: ActionResult[] = [];
    const writableTargets = new Map<string, FileAction>();

    for (const action of actions) {
      let absolutePath: string;
      try {
        absolutePath = this.pathJail.resolve(action.path);
      } catch (error: unknown) {
        const detail = error instanceof Error ? error.message : String(error);
        failures.push({ action, status: 'failed', detail });
        continue;
      }

      if (action.operation === 'READ') continue;

      const duplicateKey = process.platform === 'win32' || process.platform === 'darwin'
        ? absolutePath.toLowerCase()
        : absolutePath;
      const previous = writableTargets.get(duplicateKey);
      if (previous) {
        failures.push({
          action,
          status: 'failed',
          detail:
            `Duplicate writable target '${action.path}' resolves to the same file as ` +
            `'${previous.path}'. A batch may mutate each canonical path only once.`,
        });
        continue;
      }

      writableTargets.set(duplicateKey, action);
    }

    return failures;
  }

  private appendUnverifiedExecutionResults(
    context: InternalSessionContext,
    results: ActionResult[],
    failureMessage: string,
  ): void {
    for (const action of context.logs.executionOrder) {
      const existing = results.find(result => result.action === action);
      if (existing) {
        if (existing.status === 'verified' || existing.status === 'noop') {
          existing.status = 'failed';
          existing.detail = `${existing.detail} Batch aborted: ${failureMessage}; rollback attempted.`;
        }
        continue;
      }
      let before: FileSnapshotSummary | undefined;
      try {
        before = summarizeSnapshot(context.getSnapshot(action.path, 'before'));
      } catch {
        // The failure itself may be a path-safety error. Never allow audit
        // enrichment to prevent the rollback attempt in the outer catch.
      }
      results.push({
        action,
        status: 'failed',
        detail: `Applied but not fully verified: ${failureMessage}; rollback attempted.`,
        before,
      });
    }
  }

  private executeAction(action: FileAction, ctx: InternalSessionContext): void {
    try {
      let absPath = this.pathJail.resolve(action.path);
      const before = ctx.getSnapshot(action.path, 'before');

      switch (action.operation) {
        case 'CREATE': {
          if (existsSync(absPath)) {
            throw new Error(`CREATE failed: file already exists at ${action.path}`);
          }
          if (action.content === undefined) break;

          this.pathJail.ensureParentDirectories(
            absPath,
            directory => ctx.recordCreatedDir(directory),
          );
          absPath = this.pathJail.resolve(action.path);

          this.atomicWriter.write(absPath, action.content, {
            createOnly: true,
            afterTempCreated: tempPath => this.assertAtomicTempPath(tempPath),
            beforeCommit: () => {
              const commitPath = this.pathJail.resolve(action.path);
              if (commitPath !== absPath || existsSync(commitPath)) {
                throw new Error(`CREATE failed: file already exists at ${action.path}`);
              }
              this.assertUnchangedSinceSnapshot(action, before);
            },
            onCommitted: () => ctx.recordCommitted(action),
          });
          break;
        }

        case 'MODIFY': {
          if (!existsSync(absPath)) {
            throw new Error(`MODIFY failed: file does not exist at ${action.path}`);
          }
          if (action.content === undefined) break;

          const mode = statSync(absPath).mode;
          this.atomicWriter.write(absPath, action.content, {
            createOnly: false,
            mode,
            afterTempCreated: tempPath => this.assertAtomicTempPath(tempPath),
            beforeCommit: () => {
              const commitPath = this.pathJail.resolve(action.path);
              if (commitPath !== absPath || !existsSync(commitPath)) {
                throw new Error(`MODIFY failed: file does not exist at ${action.path}`);
              }
              this.assertUnchangedSinceSnapshot(action, before);
            },
            onCommitted: () => ctx.recordCommitted(action),
          });
          break;
        }

        case 'DELETE': {
          if (!existsSync(absPath)) break;
          absPath = this.pathJail.resolve(action.path);
          this.assertUnchangedSinceSnapshot(action, before);
          unlinkSync(absPath);
          ctx.recordCommitted(action);
          break;
        }

        case 'READ':
          break;
      }
    } catch (error: unknown) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`Execution failed for ${action.path}: ${detail}`, { cause: error });
    }
  }

  private assertAtomicTempPath(tempPath: string): void {
    const safeTempPath = this.pathJail.resolve(tempPath);
    if (safeTempPath !== tempPath) {
      throw new Error(`Atomic staging path escaped the configured root: ${tempPath}`);
    }
  }

  private assertUnchangedSinceSnapshot(action: FileAction, expected: FileSnapshot): void {
    const absPath = this.pathJail.resolve(action.path);
    const current = snapshotFile(absPath, { includeContent: false });
    if (!snapshotStateMatches(current, expected)) {
      throw new Error(
        `Concurrency Drift: ${action.path} changed after the before-snapshot; refusing to ${action.operation}.`,
      );
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

  private resolveRollbackOutcome(
    overallSuccess: boolean,
    ctx: InternalSessionContext,
  ): {
    status: SWDRollbackStatus;
    anyRolledBack: boolean;
    recoveryRequired: boolean;
    errors: string[];
  } {
    if (overallSuccess || this.options.dryRun || !ctx.hasRollbackWork()) {
      return {
        status: 'not-needed',
        anyRolledBack: false,
        recoveryRequired: false,
        errors: [],
      };
    }

    if (!this.options.enableRollback) {
      return {
        status: 'disabled',
        anyRolledBack: false,
        recoveryRequired: true,
        errors: ['Rollback was disabled after one or more filesystem mutations committed. Manual recovery is required.'],
      };
    }

    const report = this.performRollback(ctx);
    const status: SWDRollbackStatus = report.filesystemFailures === 0
      ? 'complete'
      : report.restoredCount > 0
        ? 'partial'
        : 'failed';

    return {
      status,
      anyRolledBack: report.anyRolledBack,
      recoveryRequired: report.filesystemFailures > 0,
      errors: report.errors,
    };
  }

  private performRollback(ctx: InternalSessionContext): {
    anyRolledBack: boolean;
    restoredCount: number;
    filesystemFailures: number;
    errors: string[];
  } {
    const revOrder = [...ctx.logs.executionOrder].reverse();
    const seenPaths = new Set<string>();
    const errors: string[] = [];
    let anyRolledBack = false;
    let restoredCount = 0;
    let filesystemFailures = 0;

    for (const action of revOrder) {
      try {
        const absPath = this.pathJail.resolve(action.path);
        if (seenPaths.has(absPath)) continue;
        seenPaths.add(absPath);
        const original = ctx.logs.rollbackMap.get(absPath);
        const committed = ctx.getCachedAfterSnapshot(action.path);
        const current = snapshotFile(absPath, { includeContent: false });

        if (!original) continue;

        if (!snapshotStateMatches(current, committed)) {
          throw new Error(`Concurrency Drift: Skipping rollback for ${action.path}`);
        }

        if (original.exists) {
          if (original.content === null) {
            throw new Error('original content was not captured because the snapshot exceeded the rollback content cap');
          }

          this.atomicWriter.write(absPath, original.content, {
            createOnly: !current.exists,
            mode: original.mode ?? undefined,
            afterTempCreated: tempPath => this.assertAtomicTempPath(tempPath),
            beforeCommit: () => {
              const rollbackPath = this.pathJail.resolve(action.path);
              if (rollbackPath !== absPath) {
                throw new Error(`Rollback path changed for ${action.path}`);
              }
              const latest = snapshotFile(rollbackPath, { includeContent: false });
              if (!snapshotStateMatches(latest, current)) {
                throw new Error(`Concurrency Drift: Skipping rollback for ${action.path}`);
              }
            },
          });
        } else if (current.exists) {
          const rollbackPath = this.pathJail.resolve(action.path);
          const latest = snapshotFile(rollbackPath, { includeContent: false });
          if (!snapshotStateMatches(latest, current)) {
            throw new Error(`Concurrency Drift: Skipping rollback for ${action.path}`);
          }
          unlinkSync(rollbackPath);
        }

        anyRolledBack = true;
        restoredCount += 1;
        try {
          this.options.onRollback(action.path, true);
        } catch (hookError: unknown) {
          const hookMessage = hookError instanceof Error ? hookError.message : String(hookError);
          errors.push(`Rollback hook failed for ${action.path}: ${hookMessage}`);
        }
      } catch (error: unknown) {
        filesystemFailures += 1;
        const detail = error instanceof Error ? error.message : String(error);
        const msg = detail.startsWith('Concurrency Drift:')
          ? detail
          : `Rollback failed for ${action.path}: ${detail}`;
        errors.push(msg);
        try {
          this.options.onRollback(action.path, false, detail);
        } catch {
          // Rollback hooks are advisory and must never replace the real error.
        }
      }
    }

    // Remove only directories created by this run, deepest-first. A directory
    // that gained external content is retained and reported as recovery work.
    for (const dir of ctx.logs.createdDirs) {
      try {
        const safeDir = this.pathJail.resolve(dir);
        if (!existsSync(safeDir)) continue;
        rmdirSync(safeDir);
        anyRolledBack = true;
        restoredCount += 1;
      } catch (error: unknown) {
        if (isMissingPathError(error)) continue;
        filesystemFailures += 1;
        const detail = error instanceof Error ? error.message : String(error);
        errors.push(`Rollback could not remove created directory ${dir}: ${detail}`);
      }
    }

    return { anyRolledBack, restoredCount, filesystemFailures, errors };
  }

}

// ── Internal Helpers ─────────────────────────────────────────
class InternalSessionContext {
  constructor(
    private readonly pathJail: PathJail,
    private readonly maxSnapshotBytes: number = MAX_ROLLBACK_SNAPSHOT_BYTES,
  ) {}
  public snapshots = { before: new Map<string, FileSnapshot>(), after: new Map<string, FileSnapshot>() };
  public logs = {
    executionOrder: [] as FileAction[],
    rollbackMap: new Map<string, FileSnapshot>(),
    // Directories created by CREATE actions in this run (deepest-first),
    // candidates for empty-dir cleanup during rollback.
    createdDirs: [] as string[],
  };

  public recordCreatedDir(dir: string): void {
    if (!this.logs.createdDirs.includes(dir)) this.logs.createdDirs.push(dir);
    // Keep deepest-first ordering by path length descending as a cheap proxy.
    this.logs.createdDirs.sort((a, b) => b.length - a.length);
  }

  public getSnapshot(path: string, type: 'before' | 'after'): FileSnapshot {
    const absPath = this.pathJail.resolve(path);

    // 'before' snapshots are memoized — we always want the original pre-run state.
    if (type === 'before') {
      if (this.snapshots.before.has(absPath)) return this.snapshots.before.get(absPath)!;
      const snap = snapshotFile(absPath, { includeContent: true, maxContentBytes: this.maxSnapshotBytes });
      this.snapshots.before.set(absPath, snap);
      if (!this.logs.rollbackMap.has(absPath)) this.logs.rollbackMap.set(absPath, snap);
      return snap;
    }

    // 'after' snapshots always re-read disk state. If two actions touch the same
    // file in one run, the second verification must see the latest disk reality.
    const snap = snapshotFile(absPath, { includeContent: false });
    this.snapshots.after.set(absPath, snap);
    return snap;
  }

  public recordCommitted(action: FileAction): void {
    this.logs.executionOrder.push(action);
    // Capture the exact committed state immediately. If a later action throws
    // before the verification pass, rollback must not treat a subsequent
    // external edit as the state Mythos itself wrote.
    this.getSnapshot(action.path, 'after');
  }

  public getCachedAfterSnapshot(path: string): FileSnapshot {
    const absPath = this.pathJail.resolve(path);
    return this.snapshots.after.get(absPath) ?? this.getSnapshot(path, 'after');
  }

  public hasRollbackWork(): boolean {
    return this.logs.executionOrder.length > 0 || this.logs.createdDirs.length > 0;
  }
}

function snapshotStateMatches(left: FileSnapshot, right: FileSnapshot): boolean {
  return left.exists === right.exists && left.hash === right.hash && left.mode === right.mode;
}

function isMissingPathError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

export function resolveSafePath(unsafePath: string, rootDir: string = process.cwd()): string {
  return new PathJail(rootDir).resolve(unsafePath);
}

export interface SnapshotFileOptions {
  includeContent?: boolean;
  maxContentBytes?: number;
}

function hashFileSync(filePath: string): string {
  const hash = createHash('sha256');
  const fd = openSync(filePath, 'r');
  const buffer = Buffer.allocUnsafe(1024 * 1024);

  try {
    while (true) {
      const bytesRead = readSync(fd, buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    closeSync(fd);
  }

  return hash.digest('hex');
}

export function snapshotFile(filePath: string, options: SnapshotFileOptions = {}): FileSnapshot {
  try {
    if (!existsSync(filePath)) return { path: filePath, exists: false, size: 0, mtime: 0, hash: '', content: null, mode: null };
    const stat = statSync(filePath);
    const includeContent = options.includeContent ?? true;
    const maxContentBytes = options.maxContentBytes ?? MAX_ROLLBACK_SNAPSHOT_BYTES;

    if (includeContent && stat.size <= maxContentBytes) {
      const content = readFileSync(filePath);
      const hash = createHash('sha256').update(content).digest('hex');
      return { path: filePath, exists: true, size: stat.size, mtime: stat.mtimeMs, hash, content, mode: stat.mode };
    }

    const hash = hashFileSync(filePath);
    return { path: filePath, exists: true, size: stat.size, mtime: stat.mtimeMs, hash, content: null, mode: stat.mode };
  } catch (err: any) {
    if (err.code === 'ENOENT') {
      return { path: filePath, exists: false, size: 0, mtime: 0, hash: '', content: null, mode: null };
    }
    throw new Error(`Failed to snapshot file ${filePath}: ${err.message}`);
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

// True when `idx` sits at the start of a line in `s`, allowing leading
// indentation (spaces/tabs). Used to anchor protocol markers to line starts so
// markers *mentioned inside file content* (e.g. docs about this very format)
// are not mistaken for structure.
function isAtLineStart(s: string, idx: number): boolean {
  let i = idx - 1;
  while (i >= 0 && (s[i] === ' ' || s[i] === '\t')) i--;
  return i < 0 || s[i] === '\n';
}

// Next occurrence of `needle` in `s` at or after `from` that is anchored to a
// line start. Returns -1 when none exists.
function nextLineStartIndex(s: string, needle: string, from: number): number {
  let idx = s.indexOf(needle, from);
  while (idx !== -1 && !isAtLineStart(s, idx)) {
    idx = s.indexOf(needle, idx + 1);
  }
  return idx;
}

// LAST line-start occurrence of `needle` strictly before `limit`.
function lastLineStartIndexBefore(s: string, needle: string, from: number, limit: number): number {
  let best = -1;
  let idx = nextLineStartIndex(s, needle, from);
  while (idx !== -1 && idx < limit) {
    best = idx;
    idx = nextLineStartIndex(s, needle, idx + 1);
  }
  return best;
}

// Shared field validation, used by both the text-block parser and the
// structured tool-call normalizer so the two input paths apply identical
// safety rules. Segment-based: 'a/../b' is rejected, but a filename that merely
// contains '..' (e.g. 'backup..old.txt') is allowed. resolveSafePath()
// re-validates at execution time regardless.
export function isPathShapeSafe(path: string): boolean {
  return isSafeRelativePathShape(path);
}

function resolveActionIntent(operationUpper: string, intent?: string): ActionIntent {
  const intentUpper = intent?.toUpperCase();
  if (intentUpper === 'NOOP') return 'NOOP';
  if (intentUpper === 'UNKNOWN') return 'UNKNOWN';
  if (intentUpper === 'MUTATE') return 'MUTATE';
  // No explicit intent: a READ is inherently a no-op; everything else is a
  // mutation. This mirrors the JSON action normalizer and prevents a raw READ
  // (no intent) from failing as a MUTATE/noop mismatch.
  return operationUpper === 'READ' ? 'NOOP' : 'MUTATE';
}

export function parseActions(output: string): FileAction[] {
  const actions: FileAction[] = [];
  let cursor = 0;
  const START_TAG = '[FILE_ACTION:';
  const END_TAG = '[/FILE_ACTION]';

  const MAX_ACTION_BLOCK_CHARS = 250_000;

  while (true) {
    // Structure markers must sit at a line start. A START/END tag embedded
    // mid-line inside file content (e.g. "blocks end with [/FILE_ACTION]")
    // is data, not structure.
    const startIdx = nextLineStartIndex(output, START_TAG, cursor);
    if (startIdx === -1) break;

    // The block is terminated by the LAST line-start END_TAG before the next
    // line-start START_TAG (or end of output). Taking the last terminator —
    // rather than the first — means content that itself contains a line-start
    // "[/FILE_ACTION]" (parser tests, protocol docs) is no longer silently
    // truncated at the embedded marker.
    const nextStartIdx = nextLineStartIndex(output, START_TAG, startIdx + START_TAG.length);
    const searchLimit = nextStartIdx === -1 ? output.length : nextStartIdx;
    const endIdx = lastLineStartIndexBefore(output, END_TAG, startIdx, searchLimit);

    if (endIdx === -1) {
      // Unterminated block: skip it, but keep scanning so a later
      // well-formed block in the same output still parses.
      if (nextStartIdx === -1) break;
      cursor = nextStartIdx;
      continue;
    }

    if (endIdx - startIdx > MAX_ACTION_BLOCK_CHARS) {
      cursor = endIdx + END_TAG.length;
      continue;
    }

    const block = output.slice(startIdx, endIdx + END_TAG.length);
    cursor = endIdx + END_TAG.length;

    // Header region: everything before the line-start CONTENT: marker (or the
    // whole block when there is no content). Restricting field extraction to
    // the header prevents lines *inside file content* that happen to start
    // with "OPERATION:" / "DESCRIPTION:" etc. from being read as fields.
    const contentMarkerIdx = nextLineStartIndex(block, 'CONTENT:', 0);
    const headerRegion = contentMarkerIdx === -1 ? block : block.slice(0, contentMarkerIdx);
    const lines = headerRegion.split(/\r?\n/).map(l => l.trim());

    // 1. Extract Path from the start tag line
    const firstLine = lines[0] || '';
    const pathEndIdx = firstLine.lastIndexOf(']');
    const path = pathEndIdx !== -1 ? firstLine.slice(START_TAG.length, pathEndIdx).trim() : '';

    // 2. Extract single-line fields (header region only)
    const getField = (prefix: string) => {
      const line = lines.find(l => l.toUpperCase().startsWith(prefix.toUpperCase()));
      return line ? line.slice(prefix.length).trim() : undefined;
    };

    const operation = getField('OPERATION:');
    const intent = getField('INTENT:');
    const contentHash = getField('CONTENT_HASH:');
    const description = getField('DESCRIPTION:');

    // 3. Extract multi-line Content — from the line-start CONTENT: marker up
    // to the block's terminating END_TAG (the block already ends at the
    // correct, last terminator, so lastIndexOf here is exact).
    let content: string | undefined;
    if (contentMarkerIdx !== -1) {
      let rawContent = block.slice(contentMarkerIdx + 'CONTENT:'.length, block.lastIndexOf(END_TAG));
      rawContent = rawContent.replace(/^[ \t]*\r?\n/, '');
      rawContent = rawContent.replace(/\r?\n[ \t]*$/, '');
      content = rawContent;
    }

    if (path && operation && description) {
      // Segment-based traversal check shared with the tool-call normalizer.
      if (!isPathShapeSafe(path)) {
        continue;
      }

      const opUpper = operation.toUpperCase();
      if (!['CREATE', 'MODIFY', 'DELETE', 'READ'].includes(opUpper)) {
        continue;
      }

      actions.push({
        path,
        operation: opUpper as FileAction['operation'],
        intent: resolveActionIntent(opUpper, intent),
        contentHash,
        description,
        content,
      });
    }
  }
  return actions;
}

// ── Native tool-call input ───────────────────────────────────
export interface ToolCallFileAction {
  path: string;
  operation: string;
  intent?: string;
  description?: string;
  content?: string;
  contentHash?: string;
}

/**
 * Normalize native tool/function-calling arguments into validated FileActions,
 * applying the SAME path-safety and field rules as parseActions(). A provider
 * that supports structured tool calls (Anthropic, OpenAI) can emit the
 * FILE_ACTION envelope as JSON arguments and route it through SWD without
 * re-implementing validation. The verification trust boundary is unchanged —
 * SWD still computes the SHA-256 from disk and rolls back on mismatch — only
 * the input format differs. Invalid entries are dropped; oversized content is
 * left for SWDEngine.run() to reject with a clean failure (not silently lost).
 */
export function actionsFromToolCalls(raw: ToolCallFileAction | ToolCallFileAction[]): FileAction[] {
  const entries = Array.isArray(raw) ? raw : [raw];
  const actions: FileAction[] = [];

  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue;

    const path = typeof entry.path === 'string' ? entry.path.trim() : '';
    const operation = typeof entry.operation === 'string' ? entry.operation.trim() : '';
    if (!path || !operation || !isPathShapeSafe(path)) continue;

    const opUpper = operation.toUpperCase();
    if (!['CREATE', 'MODIFY', 'DELETE', 'READ'].includes(opUpper)) continue;

    const description = typeof entry.description === 'string' && entry.description.trim()
      ? entry.description.trim()
      : `${opUpper} ${path}`;

    actions.push({
      path,
      operation: opUpper as FileAction['operation'],
      intent: resolveActionIntent(opUpper, entry.intent),
      contentHash: typeof entry.contentHash === 'string' ? entry.contentHash : undefined,
      description,
      content: typeof entry.content === 'string' ? entry.content : undefined,
    });
  }

  return actions;
}
export function summarizeActions(output: string, userInput: string): string {
  const actions = parseActions(output);
  return actions.length > 0 ? actions.map(a => `${a.operation}: ${a.path}`).join('; ') : `chat: ${userInput.slice(0, 80)}`;
}
