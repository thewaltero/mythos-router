import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createSWDReceipt,
  listReceipts,
  readReceipt,
  saveSWDReceipt,
  verifyReceipt,
  verifyReceiptIntegrity,
  sanitizeReceiptOutputTail,
  RECEIPT_OUTPUT_TAIL_MAX_CHARS,
} from '../src/receipts.js';
import type { SWDRunResult } from '../src/swd.js';

const originalCwd = process.cwd();
let tempDir = '';

describe('SWD receipts', () => {
  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'mythos-receipts-'));
    process.chdir(tempDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('saves, lists, reads, and verifies a receipt', () => {
    const beforeContent = 'before';
    const afterContent = 'after';
    const filePath = 'sample.txt';
    const absPath = join(tempDir, filePath);

    writeFileSync(absPath, afterContent, 'utf-8');

    const runResult: SWDRunResult = {
      success: true,
      rolledBack: false,
      rollbackErrors: [],
      errors: [],
      results: [
        {
          action: {
            path: filePath,
            operation: 'MODIFY',
            intent: 'MUTATE',
            description: 'Update sample file',
          },
          status: 'verified',
          detail: `Verified: MODIFY ${filePath}`,
          before: {
            path: absPath,
            exists: true,
            size: beforeContent.length,
            mtime: 1,
            hash: sha256(beforeContent),
          },
          after: {
            path: absPath,
            exists: true,
            size: afterContent.length,
            mtime: 2,
            hash: sha256(afterContent),
          },
        },
      ],
    };

    const receipt = createSWDReceipt({
      request: 'change sample',
      summary: 'MODIFY: sample.txt',
      result: runResult,
      usage: {
        inputTokens: 100,
        outputTokens: 25,
      },
      skills: [
        {
          id: 'repo',
          name: 'repo',
          version: '1.0.0',
          source: 'project',
          path: '.mythos/skills/repo/SKILL.md',
        },
        {
          id: 'personal',
          name: 'personal',
          version: '0.1.0',
          source: 'global',
          path: join(tmpdir(), 'personal', 'SKILL.md'),
        },
      ],
    });

    const savedPath = saveSWDReceipt(receipt);
    assert.ok(savedPath?.endsWith(`${receipt.id}.json`));

    const listed = listReceipts();
    assert.equal(listed.length, 1);
    assert.equal(listed[0]!.id, receipt.id);

    const loaded = readReceipt(receipt.id);
    assert.equal(loaded?.id, receipt.id);
    assert.equal(loaded ? verifyReceiptIntegrity(loaded) : false, true);

    const verification = verifyReceipt(receipt);
    assert.equal(verification.ok, true);
    assert.equal(verification.files[0]!.status, 'ok');
    assert.equal(receipt.files[0]!.after?.path, filePath);
    assert.equal(receipt.skills?.[0]?.id, 'repo');
    assert.equal(receipt.skills?.[0]?.source, 'project');
    assert.equal(receipt.skills?.[0]?.path, '.mythos/skills/repo/SKILL.md');
    assert.equal(receipt.skills?.[1]?.id, 'personal');
    assert.equal(receipt.skills?.[1]?.path, undefined);
  });

  it('normalizes receipt paths even when cwd is a symlinked project root', (t) => {
    const filePath = 'linked-root.txt';
    const absPath = join(tempDir, filePath);
    const linkParent = mkdtempSync(join(tmpdir(), 'mythos-receipts-link-'));
    const linkDir = join(linkParent, 'project');

    try {
      symlinkSync(tempDir, linkDir, process.platform === 'win32' ? 'junction' : 'dir');
    } catch {
      rmSync(linkParent, { recursive: true, force: true });
      t.skip('Directory symlinks are not available in this environment');
      return;
    }

    try {
      process.chdir(linkDir);
      writeFileSync(absPath, 'linked content', 'utf-8');

      const receipt = createSWDReceipt({
        request: 'change linked file',
        summary: 'MODIFY: linked-root.txt',
        result: {
          success: true,
          rolledBack: false,
          rollbackErrors: [],
          errors: [],
          results: [
            {
              action: {
                path: filePath,
                operation: 'MODIFY',
                intent: 'MUTATE',
                description: 'Update linked-root file',
              },
              status: 'verified',
              detail: `Verified: MODIFY ${filePath}`,
              before: {
                path: absPath,
                exists: true,
                size: 0,
                mtime: 1,
                hash: sha256(''),
              },
              after: {
                path: absPath,
                exists: true,
                size: 'linked content'.length,
                mtime: 2,
                hash: sha256('linked content'),
              },
            },
          ],
        },
      });

      assert.equal(receipt.files[0]!.path, filePath);
      assert.equal(receipt.files[0]!.before?.path, filePath);
      assert.equal(receipt.files[0]!.after?.path, filePath);
      assert.equal(verifyReceipt(receipt).ok, true);
    } finally {
      process.chdir(tempDir);
      rmSync(linkParent, { recursive: true, force: true });
    }
  });

  it('detects drift from the expected receipt state', () => {
    const filePath = 'drift.txt';
    const absPath = join(tempDir, filePath);
    writeFileSync(absPath, 'expected', 'utf-8');

    const receipt = createSWDReceipt({
      request: 'create drift file',
      summary: 'CREATE: drift.txt',
      result: {
        success: true,
        rolledBack: false,
        rollbackErrors: [],
        errors: [],
        results: [
          {
            action: {
              path: filePath,
              operation: 'CREATE',
              intent: 'MUTATE',
              description: 'Create drift file',
            },
            status: 'verified',
            detail: `Verified: CREATE ${filePath}`,
            before: {
              path: absPath,
              exists: false,
              size: 0,
              mtime: 0,
              hash: '',
            },
            after: {
              path: absPath,
              exists: true,
              size: 'expected'.length,
              mtime: 1,
              hash: sha256('expected'),
            },
          },
        ],
      },
    });

    writeFileSync(absPath, 'changed', 'utf-8');

    const verification = verifyReceipt(receipt);
    assert.equal(verification.ok, false);
    assert.equal(verification.files[0]!.status, 'drifted');
  });

  it('sanitizes receipt test output tails before storage', () => {
    const longPrefix = 'a'.repeat(RECEIPT_OUTPUT_TAIL_MAX_CHARS + 25);
    const output = `${longPrefix}
OPENAI_API_KEY=sk-proj-${'x'.repeat(32)}
Authorization: Bearer ${'y'.repeat(40)}
`;

    const tail = sanitizeReceiptOutputTail(output);

    assert.ok(tail.length <= RECEIPT_OUTPUT_TAIL_MAX_CHARS + '[REDACTED_SECRET]'.length * 2);
    assert.doesNotMatch(tail, /sk-proj-/);
    assert.doesNotMatch(tail, /Bearer y/);
    assert.match(tail, /\[REDACTED_SECRET\]/);
  });

});

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}
