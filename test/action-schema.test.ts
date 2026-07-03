import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseExternalAgentEnvelope,
  validateExternalAgentInput,
  validateTaskContractForActions,
} from '../src/action-schema.js';

describe('external-agent action schema', () => {
  it('validates a contract-gated JSON envelope', () => {
    const raw = JSON.stringify({
      request: 'schema smoke',
      agent: { id: 'schema-agent', model: 'manual' },
      contract: {
        allowedPaths: ['src/**'],
        expectedOutputs: ['src/schema-smoke.ts'],
      },
      actions: [{
        path: 'src/schema-smoke.ts',
        operation: 'CREATE',
        description: 'Create schema smoke file',
        content: 'export const ok = true;\n',
      }],
    });

    const validation = validateExternalAgentInput(raw);
    assert.equal(validation.ok, true);
    assert.equal(validation.format, 'json-envelope');
    assert.equal(validation.actionCount, 1);
    assert.equal(validation.contract?.ok, true);
  });

  it('rejects unsafe JSON action paths during validation', () => {
    const validation = validateExternalAgentInput(JSON.stringify({
      actions: [{ path: '../outside.txt', operation: 'CREATE', content: 'bad\n' }],
    }));

    assert.equal(validation.ok, false);
    assert.match(validation.errors.join('\n'), /Invalid action path/);
  });

  it('enforces blocked and expected task contract paths', () => {
    const result = validateTaskContractForActions([
      {
        path: 'src/allowed.ts',
        operation: 'CREATE',
        intent: 'MUTATE',
        description: 'allowed',
        content: 'ok\n',
      },
    ], {
      allowedPaths: ['src/**'],
      blockedPaths: ['src/secret.ts'],
      expectedOutputs: ['test/allowed.test.ts'],
    });

    assert.equal(result.ok, false);
    assert.match(result.errors.join('\n'), /expected output/);
  });

  it('parses FILE_ACTION text as legacy-compatible input', () => {
    const parsed = parseExternalAgentEnvelope(`
[FILE_ACTION: src/from-text.ts]
OPERATION: CREATE
INTENT: MUTATE
DESCRIPTION: text action
CONTENT:
export const fromText = true;
[/FILE_ACTION]
`);

    assert.equal(parsed.format, 'file-action-text');
    assert.equal(parsed.actions.length, 1);
    assert.equal(parsed.actions[0]?.path, 'src/from-text.ts');
  });

  it('preserves and enforces a contract carried in an { output } text envelope', () => {
    const raw = JSON.stringify({
      agent: { id: 'ext-agent', model: 'some-model' },
      contract: { blockedPaths: ['src/secret.ts'] },
      output: [
        '[FILE_ACTION: src/secret.ts]',
        'OPERATION: CREATE',
        'INTENT: MUTATE',
        'DESCRIPTION: should be blocked by contract',
        'CONTENT:',
        'export const leaked = true;',
        '[/FILE_ACTION]',
      ].join('\n'),
    });

    const parsed = parseExternalAgentEnvelope(raw);
    assert.equal(parsed.format, 'file-action-text');
    // The contract and agent must survive the text-envelope path.
    assert.deepEqual(parsed.contract?.blockedPaths, ['src/secret.ts']);
    assert.equal(parsed.agent?.id, 'ext-agent');

    const validation = validateExternalAgentInput(raw);
    assert.equal(validation.ok, false);
    assert.equal(validation.contract?.ok, false);
    assert.match(validation.contract?.errors.join('\n') ?? '', /blocked/i);
  });

  it('allows filenames and contract patterns that merely contain ".." inside a segment', () => {
    const raw = JSON.stringify({
      contract: {
        allowedPaths: ['docs/backup..old/**'],
        expectedOutputs: ['docs/backup..old/readme.md'],
      },
      actions: [{
        path: 'docs/backup..old/readme.md',
        operation: 'CREATE',
        description: 'Create backup docs',
        content: 'ok\n',
      }],
    });

    const validation = validateExternalAgentInput(raw);
    assert.equal(validation.ok, true);
    assert.equal(validation.contract?.ok, true);
  });

  it('still rejects real parent traversal in contract patterns', () => {
    const validation = validateExternalAgentInput(JSON.stringify({
      contract: { allowedPaths: ['docs/../secret/**'] },
      actions: [{ path: 'docs/readme.md', operation: 'CREATE', content: 'ok\n' }],
    }));

    assert.equal(validation.ok, false);
    assert.match(validation.errors.join('\n'), /unsafe pattern/);
  });

});
