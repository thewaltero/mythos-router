// ─────────────────────────────────────────────────────────────
//  mythos-router :: receipt-undo.ts
//  Replay a verified SWD receipt in reverse — safely.
//
//  Design constraints (intentional):
//   - Receipts store snapshot HASHES, not file content (THREAT_MODEL.md:
//     "not raw agent input or file contents"). So undo can only fully
//     reverse a CREATE (by deleting what was created). MODIFY/DELETE would
//     require the prior content, which is not stored — so they are reported
//     honestly as not auto-reversible rather than guessed at.
//   - Undo is itself a verified write: reversal actions run through the same
//     security policy review + SWDEngine as any other change, and produce a
//     new receipt. Undo can never bypass the sensitive-file blocklist.
//   - Fail closed: nothing is written unless the caller explicitly applies,
//     and a file is only reversed if the working tree still matches what the
//     receipt produced (no clobbering newer edits) unless `force` is set.
// ─────────────────────────────────────────────────────────────

import { SWDEngine, type FileAction, type SWDRunResult } from './swd.js';
import { reviewActions, type ActionRiskVerdict } from './security-policy.js';
import {
  createSWDReceipt,
  saveSWDReceipt,
  verifyReceipt,
  verifyReceiptIntegrity,
  type ReceiptFileResult,
  type ReceiptFileVerification,
  type SWDReceipt,
} from './receipts.js';
import { isGitRepo, getCurrentBranch, getLatestHash } from './git.js';

export type UndoClassification =
  | 'reverse-delete' // original CREATE → reverse by deleting the created file
  | 'skip-not-applied' // original action was not a verified mutation (READ / failed)
  | 'skip-no-content' // MODIFY/DELETE — prior content is not stored in the receipt
  | 'skip-drifted' // working tree no longer matches what the receipt produced
  | 'skip-already-absent'; // CREATE reversal, but the file is already gone

export interface UndoPlanItem {
  path: string;
  originalOperation: string;
  classification: UndoClassification;
  reason: string;
  /** Present only when the item is reversible; the action that undoes it. */
  reversal?: FileAction;
  /** For skip-no-content under git: a manual command the operator can run. */
  gitHint?: string;
}

export interface UndoPlan {
  receiptId: string;
  integrityOk: boolean;
  rolledBack: boolean;
  items: UndoPlanItem[];
  /** Items that produced a reversal action (subset of `items`). */
  reversible: UndoPlanItem[];
}

export interface UndoExecution {
  applied: boolean;
  ok: boolean;
  blocked: Array<{ path: string; operation: string; reason: string }>;
  result?: SWDRunResult;
  receipt?: { id: string; path: string };
  errors: string[];
}

export interface UndoOutcome {
  plan: UndoPlan;
  execution: UndoExecution;
}

const NON_MUTATING_STATUSES = new Set(['failed', 'drift']);

function gitContext(): { branch?: string; commit?: string } | undefined {
  if (!isGitRepo()) return undefined;
  const branch = getCurrentBranch();
  const commit = getLatestHash();
  const ctx: { branch?: string; commit?: string } = {};
  if (branch && branch !== 'unknown') ctx.branch = branch;
  if (commit && commit !== 'unknown') ctx.commit = commit;
  return ctx.branch || ctx.commit ? ctx : undefined;
}

function verificationFor(
  path: string,
  verifications: ReceiptFileVerification[],
): ReceiptFileVerification | undefined {
  return verifications.find((entry) => entry.path === path);
}

function gitRestoreHint(receipt: SWDReceipt, file: ReceiptFileResult): string | undefined {
  const commit = receipt.git?.commit;
  if (!commit || commit === 'unknown') return undefined;
  // The receipt's commit is the project's git HEAD at receipt time. We surface
  // it as a manual hint only — we never run it, because whether the prior
  // content lives at this commit or its parent depends on the session's commit
  // flow, and guessing wrong would corrupt the tree.
  return `git checkout ${commit.slice(0, 12)} -- ${file.path}`;
}

function classifyFile(
  receipt: SWDReceipt,
  file: ReceiptFileResult,
  verification: ReceiptFileVerification | undefined,
  force: boolean,
): UndoPlanItem {
  const base = { path: file.path, originalOperation: file.operation };

  // Only verified mutations are candidates for reversal.
  if (file.operation === 'READ' || NON_MUTATING_STATUSES.has(file.status)) {
    return {
      ...base,
      classification: 'skip-not-applied',
      reason: `Original action was not a verified mutation (status: ${file.status}).`,
    };
  }

  if (file.operation === 'MODIFY' || file.operation === 'DELETE') {
    const item: UndoPlanItem = {
      ...base,
      classification: 'skip-no-content',
      reason:
        file.operation === 'MODIFY'
          ? 'Cannot auto-undo a MODIFY: the receipt stores hashes, not the prior file content.'
          : 'Cannot auto-undo a DELETE: the receipt stores hashes, not the deleted file content.',
    };
    const hint = gitRestoreHint(receipt, file);
    if (hint) item.gitHint = hint;
    return item;
  }

  // CREATE → reverse by deleting the created file, but only if the tree still
  // matches what the receipt produced (drift gate), unless force is set.
  if (file.operation === 'CREATE') {
    const status = verification?.status;

    if (status === 'missing' && !force) {
      return {
        ...base,
        classification: 'skip-already-absent',
        reason: 'The created file is already gone — nothing to undo.',
      };
    }

    if (status === 'drifted' && !force) {
      return {
        ...base,
        classification: 'skip-drifted',
        reason:
          'The created file has changed since this receipt. Refusing to delete newer work (use --force to override).',
      };
    }

    return {
      ...base,
      classification: 'reverse-delete',
      reason:
        status === 'ok'
          ? 'Created file is unchanged since the receipt; safe to remove.'
          : 'Reversing CREATE under --force (working tree differs from the receipt).',
      reversal: {
        path: file.path,
        operation: 'DELETE',
        intent: 'MUTATE',
        description: `Undo CREATE from receipt ${receipt.id}`,
      },
    };
  }

  return {
    ...base,
    classification: 'skip-not-applied',
    reason: `Unsupported operation for undo: ${file.operation}.`,
  };
}

/**
 * Build a reversal plan for a receipt without touching the filesystem.
 * Pure aside from reading current file state via verifyReceipt (read-only).
 */
export function planUndo(receipt: SWDReceipt, options: { force?: boolean } = {}): UndoPlan {
  const force = options.force === true;
  const integrityOk = verifyReceiptIntegrity(receipt);
  const verification = verifyReceipt(receipt);

  const items = receipt.files.map((file) =>
    classifyFile(receipt, file, verificationFor(file.path, verification.files), force),
  );

  return {
    receiptId: receipt.id,
    integrityOk,
    rolledBack: receipt.swd.rolledBack,
    items,
    reversible: items.filter((item) => item.reversal !== undefined),
  };
}

/**
 * Execute a reversal plan. When `apply` is false this is a no-op preview that
 * still reports what policy would block. Reversal actions are routed through
 * the standard security policy review and SWDEngine, and on apply a new
 * receipt is written so the undo is itself auditable.
 *
 * DELETE reversals are classified as `confirm` risk by the security policy;
 * passing `apply: true` is the operator's explicit confirmation (the CLI gates
 * this behind `--yes`). Sensitive-file blocks can never be overridden here.
 */
export async function executeUndo(
  plan: UndoPlan,
  options: { apply?: boolean } = {},
): Promise<UndoExecution> {
  const apply = options.apply === true;
  const reversalActions = plan.reversible
    .map((item) => item.reversal)
    .filter((action): action is FileAction => action !== undefined);

  const review = reviewActions(reversalActions);
  const blocked = review.blocked.map(({ action, verdict }: { action: FileAction; verdict: ActionRiskVerdict }) => ({
    path: action.path,
    operation: action.operation,
    reason: verdict.reason,
  }));

  // `confirm`-class actions (e.g. DELETE) are permitted because an explicit
  // apply IS the human confirmation; blocked (sensitive) actions never run.
  const runnable = [
    ...review.approved,
    ...review.needsConfirmation.map(({ action }: { action: FileAction }) => action),
  ];

  if (!apply || runnable.length === 0) {
    return {
      applied: false,
      ok: blocked.length === 0,
      blocked,
      errors: [],
    };
  }

  const engine = new SWDEngine({ dryRun: false, strict: true, enableRollback: true });
  const result = await engine.run(runnable);

  const execution: UndoExecution = {
    applied: true,
    ok: result.success && !result.rolledBack && blocked.length === 0,
    blocked,
    result,
    errors: result.errors,
  };

  const receipt = createSWDReceipt({
    request: `undo:${plan.receiptId}`,
    summary: `Reverse ${runnable.length} change(s) from receipt ${plan.receiptId}`,
    result,
    git: gitContext(),
  });
  execution.receipt = { id: receipt.id, path: saveSWDReceipt(receipt, false) };

  return execution;
}

/** Convenience: plan + execute in one call. */
export async function undoReceipt(
  receipt: SWDReceipt,
  options: { apply?: boolean; force?: boolean } = {},
): Promise<UndoOutcome> {
  const plan = planUndo(receipt, { force: options.force });
  const execution = await executeUndo(plan, { apply: options.apply });
  return { plan, execution };
}
