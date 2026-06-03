import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSWDReceipt, saveSWDReceipt, listReceipts } from '../src/receipts.js';
import { planUndo, executeUndo, undoReceipt } from '../src/receipt-undo.js';
import type { SWDRunResult } from '../src/swd.js';

const originalCwd = process.cwd();
let tempDir = '';

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

/** Build + save a receipt describing a single CREATE of an on-disk file. */
function receiptForCreate(relPath: string, content: string) {
  const absPath = join(tempDir, relPath);
  writeFileSync(absPath, content, 'utf-8');
  const runResult: SWDRunResult = {
    success: true,
    rolledBack: false,
    rollbackErrors: [],
    errors: [],
    results: [
      {
        action: { path: relPath, operation: 'CREATE', intent: 'MUTATE', description: 'create' },
        status: 'verified',
        detail: `Verified: CREATE ${relPath}`,
        before: { path: absPath, exists: false, size: 0, mtime: 0, hash: '' },
        after: { path: absPath, exists: true, size: content.length, mtime: 2, hash: sha256(content) },
      },
    ],
  };
  const receipt = createSWDReceipt({ request: 'create file', summary: 'create', result: runResult });
  saveSWDReceipt(receipt, false);
  return { receipt, absPath };
}

function receiptForModify(relPath: string, before: string, after: string) {
  const absPath = join(tempDir, relPath);
  writeFileSync(absPath, after, 'utf-8');
  const runResult: SWDRunResult = {
    success: true,
    rolledBack: false,
    rollbackErrors: [],
    errors: [],
    results: [
      {
        action: { path: relPath, operation: 'MODIFY', intent: 'MUTATE', description: 'modify' },
        status: 'verified',
        detail: `Verified: MODIFY ${relPath}`,
        before: { path: absPath, exists: true, size: before.length, mtime: 1, hash: sha256(before) },
        after: { path: absPath, exists: true, size: after.length, mtime: 2, hash: sha256(after) },
      },
    ],
  };
  const receipt = createSWDReceipt({ request: 'modify file', summary: 'modify', result: runResult });
  saveSWDReceipt(receipt, false);
  return { receipt, absPath };
}

describe('receipt undo', () => {
  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'mythos-undo-'));
    process.chdir(tempDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('plans a CREATE as a reversible delete when the file is unchanged', () => {
    const { receipt } = receiptForCreate('created.txt', 'hello');
    const plan = planUndo(receipt);
    assert.equal(plan.integrityOk, true);
    assert.equal(plan.items.length, 1);
    assert.equal(plan.items[0].classification, 'reverse-delete');
    assert.equal(plan.reversible.length, 1);
    assert.equal(plan.reversible[0].reversal?.operation, 'DELETE');
  });

  it('preview (apply=false) does not touch the filesystem', async () => {
    const { receipt, absPath } = receiptForCreate('created.txt', 'hello');
    const plan = planUndo(receipt);
    const execution = await executeUndo(plan, { apply: false });
    assert.equal(execution.applied, false);
    assert.equal(existsSync(absPath), true, 'file must still exist after preview');
  });

  it('applies the undo, deletes the created file, and writes an undo receipt', async () => {
    const { receipt, absPath } = receiptForCreate('created.txt', 'hello');
    const before = listReceipts(100).length;
    const { execution } = await undoReceipt(receipt, { apply: true });
    assert.equal(execution.applied, true);
    assert.equal(execution.ok, true);
    assert.equal(existsSync(absPath), false, 'created file should be deleted');
    assert.ok(execution.receipt, 'an undo receipt should be written');
    assert.equal(listReceipts(100).length, before + 1);
  });

  it('refuses to reverse a CREATE that has drifted, unless forced', async () => {
    const { receipt, absPath } = receiptForCreate('created.txt', 'hello');
    writeFileSync(absPath, 'NEWER WORK', 'utf-8'); // drift the file after the receipt

    const plan = planUndo(receipt);
    assert.equal(plan.items[0].classification, 'skip-drifted');
    assert.equal(plan.reversible.length, 0);

    const forced = planUndo(receipt, { force: true });
    assert.equal(forced.items[0].classification, 'reverse-delete');
    assert.equal(forced.reversible.length, 1);
  });

  it('marks an already-absent created file as nothing-to-undo', () => {
    const { receipt, absPath } = receiptForCreate('created.txt', 'hello');
    rmSync(absPath);
    const plan = planUndo(receipt);
    assert.equal(plan.items[0].classification, 'skip-already-absent');
    assert.equal(plan.reversible.length, 0);
  });

  it('does not auto-reverse a MODIFY (prior content is not stored)', () => {
    const { receipt } = receiptForModify('changed.txt', 'old text', 'new text');
    const plan = planUndo(receipt);
    assert.equal(plan.items[0].classification, 'skip-no-content');
    assert.equal(plan.reversible.length, 0);
  });

  it('executeUndo on a non-reversible plan applies nothing', async () => {
    const { receipt, absPath } = receiptForModify('changed.txt', 'old text', 'new text');
    const plan = planUndo(receipt);
    const execution = await executeUndo(plan, { apply: true });
    assert.equal(execution.applied, false);
    assert.equal(existsSync(absPath), true);
  });
});
