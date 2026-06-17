import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  analyzeReceiptsForSkill,
  classifyFailure,
  renderLearnedSkill,
  DEFAULT_LEARNED_SKILL_NAME,
} from '../src/skill-learning.js';
import { parseSkillContent, validateSkill } from '../src/skills.js';
import type { SWDReceipt, ReceiptFileResult } from '../src/receipts.js';

function fileResult(partial: Partial<ReceiptFileResult>): ReceiptFileResult {
  return {
    path: 'src/example.ts',
    operation: 'MODIFY',
    intent: 'MUTATE',
    status: 'failed',
    detail: '',
    expectedSource: 'none',
    ...partial,
  };
}

function receipt(id: string, files: ReceiptFileResult[]): SWDReceipt {
  return {
    id,
    version: 1,
    timestamp: new Date().toISOString(),
    request: 'test',
    summary: 'test',
    fileCount: files.length,
    files,
    swd: { success: false, rolledBack: false, errors: [], rollbackErrors: [] },
  };
}

describe('skill-learning: classifyFailure', () => {
  it('classifies oversized writes', () => {
    assert.equal(
      classifyFailure(fileResult({ detail: 'Large full-file writes are blocked: 250000 bytes exceeds 200000' })),
      'oversized-write',
    );
  });

  it('classifies missing targets', () => {
    assert.equal(classifyFailure(fileResult({ detail: 'target file does not exist' })), 'missing-target');
  });

  it('classifies no-op mutations', () => {
    assert.equal(
      classifyFailure(fileResult({ intent: 'MUTATE', detail: 'file unchanged after write' })),
      'no-op-mutate',
    );
  });

  it('classifies content drift', () => {
    assert.equal(classifyFailure(fileResult({ status: 'drift', detail: 'hash mismatch' })), 'content-drift');
  });
});

describe('skill-learning: analyzeReceiptsForSkill', () => {
  it('returns no rules and a guiding note for an empty history', () => {
    const result = analyzeReceiptsForSkill([]);
    assert.equal(result.ok, true);
    assert.equal(result.analyzedReceipts, 0);
    assert.equal(result.rules.length, 0);
    assert.equal(result.skillMarkdown, null);
    assert.ok(result.notes.some((n) => n.includes('No receipts')));
  });

  it('ignores verified/noop actions and only counts failures', () => {
    const result = analyzeReceiptsForSkill([
      receipt('r1', [
        fileResult({ status: 'verified', detail: 'ok' }),
        fileResult({ status: 'noop', detail: 'unchanged' }),
      ]),
    ]);
    assert.equal(result.failureCount, 0);
    assert.equal(result.rules.length, 0);
  });

  it('does not propose a rule below the occurrence threshold', () => {
    const result = analyzeReceiptsForSkill(
      [receipt('r1', [fileResult({ status: 'drift', detail: 'hash mismatch' })])],
      { minOccurrences: 2 },
    );
    assert.equal(result.failureCount, 1);
    assert.equal(result.rules.length, 0);
    assert.ok(result.notes.some((n) => n.includes('recurred')));
  });

  it('proposes a rule once a failure category recurs across receipts', () => {
    const result = analyzeReceiptsForSkill(
      [
        receipt('r1', [fileResult({ status: 'drift', detail: 'content hash mismatch' })]),
        receipt('r2', [fileResult({ status: 'drift', detail: 'content hash mismatch' })]),
      ],
      { minOccurrences: 2 },
    );
    assert.equal(result.rules.length, 1);
    const rule = result.rules[0]!;
    assert.equal(rule.category, 'content-drift');
    assert.equal(rule.occurrences, 2);
    assert.ok(rule.evidence.includes('2 occurrence'));
    assert.ok(rule.evidence.includes('2 receipt'));
    assert.ok(typeof result.skillMarkdown === 'string' && result.skillMarkdown.length > 0);
  });

  it('orders rules by occurrence count, most frequent first', () => {
    const result = analyzeReceiptsForSkill(
      [
        receipt('r1', [
          fileResult({ status: 'drift', detail: 'content hash mismatch' }),
          fileResult({ operation: 'MODIFY', detail: 'does not exist' }),
        ]),
        receipt('r2', [
          fileResult({ status: 'drift', detail: 'content hash mismatch' }),
          fileResult({ operation: 'MODIFY', detail: 'does not exist' }),
        ]),
        receipt('r3', [fileResult({ status: 'drift', detail: 'content hash mismatch' })]),
      ],
      { minOccurrences: 2 },
    );
    assert.equal(result.rules.length, 2);
    assert.equal(result.rules[0]!.category, 'content-drift'); // 3 occurrences
    assert.equal(result.rules[0]!.occurrences, 3);
    assert.equal(result.rules[1]!.category, 'missing-target'); // 2 occurrences
  });
});

describe('skill-learning: rendered SKILL.md', () => {
  it('produces a document that parses and validates as a real skill', () => {
    const result = analyzeReceiptsForSkill(
      [
        receipt('r1', [fileResult({ status: 'drift', detail: 'content hash mismatch' })]),
        receipt('r2', [fileResult({ status: 'drift', detail: 'content hash mismatch' })]),
      ],
      { minOccurrences: 2 },
    );
    assert.ok(result.skillMarkdown);

    const skill = parseSkillContent(result.skillMarkdown!, {
      id: DEFAULT_LEARNED_SKILL_NAME,
      filePath: `/tmp/${DEFAULT_LEARNED_SKILL_NAME}/SKILL.md`,
      scope: 'project',
    });

    assert.equal(skill.meta.name, DEFAULT_LEARNED_SKILL_NAME);
    const errors = validateSkill(skill).filter((issue) => issue.level === 'error');
    assert.equal(errors.length, 0, `unexpected validation errors: ${JSON.stringify(errors)}`);
    assert.ok(skill.instructions.includes('## Rules'));
  });

  it('honors a custom skill name', () => {
    const markdown = renderLearnedSkill('custom-name', [
      { category: 'content-drift', rule: 'Do the thing.', reason: 'because', evidence: '2x', occurrences: 2 },
    ], 3);
    assert.ok(markdown.includes('name: custom-name'));
    assert.ok(markdown.includes('- Do the thing.'));
  });
});
