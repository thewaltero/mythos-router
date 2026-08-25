import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  EXTERNAL_AGENT_ACTION_SCHEMA,
  MAX_EXTERNAL_AGENT_ACTIONS,
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

  it('keeps the published JSON schema synchronized with the runtime schema', () => {
    const published = JSON.parse(readFileSync('schemas/external-agent-actions.schema.json', 'utf8'));
    assert.deepEqual(published, EXTERNAL_AGENT_ACTION_SCHEMA);
  });

  it('accepts exactly the maximum number of JSON actions', () => {
    const actions = Array.from({ length: MAX_EXTERNAL_AGENT_ACTIONS }, (_, index) => ({
      path: `src/file-${index}.ts`,
      operation: 'CREATE',
      content: 'ok\n',
    }));

    const validation = validateExternalAgentInput(JSON.stringify(actions));
    assert.equal(validation.ok, true);
    assert.equal(validation.actionCount, MAX_EXTERNAL_AGENT_ACTIONS);
  });

  it('rejects JSON and FILE_ACTION batches larger than the published maximum', () => {
    const jsonActions = Array.from({ length: MAX_EXTERNAL_AGENT_ACTIONS + 1 }, (_, index) => ({
      path: `src/file-${index}.ts`,
      operation: 'CREATE',
      content: 'ok\n',
    }));
    const jsonValidation = validateExternalAgentInput(JSON.stringify(jsonActions));
    assert.equal(jsonValidation.ok, false);
    assert.match(jsonValidation.errors.join('\n'), /maximum is 500/);

    const textActions = Array.from({ length: MAX_EXTERNAL_AGENT_ACTIONS + 1 }, (_, index) => [
      `[FILE_ACTION: src/text-${index}.ts]`,
      'OPERATION: CREATE',
      'DESCRIPTION: create',
      'CONTENT:',
      'ok',
      '[/FILE_ACTION]',
    ].join('\n')).join('\n');
    const textValidation = validateExternalAgentInput(textActions);
    assert.equal(textValidation.ok, false);
    assert.match(textValidation.errors.join('\n'), /maximum is 500/);
  });

  it('enforces request, summary, agent, and action string limits at runtime', () => {
    const cases = [
      { request: 'x'.repeat(501), actions: [{ path: 'a.ts', operation: 'CREATE' }] },
      { summary: 'x'.repeat(501), actions: [{ path: 'a.ts', operation: 'CREATE' }] },
      { agent: { id: 'x'.repeat(121) }, actions: [{ path: 'a.ts', operation: 'CREATE' }] },
      { actions: [{ path: 'a.ts', operation: 'CREATE', description: 'x'.repeat(501) }] },
    ];

    for (const value of cases) {
      const validation = validateExternalAgentInput(JSON.stringify(value));
      assert.equal(validation.ok, false);
      assert.match(validation.errors.join('\n'), /exceeds/);
    }
  });

  it('uses strict uppercase, case-sensitive JSON enums', () => {
    const lowerOperation = validateExternalAgentInput(JSON.stringify({
      actions: [{ path: 'a.ts', operation: 'create' }],
    }));
    assert.equal(lowerOperation.ok, false);
    assert.match(lowerOperation.errors.join('\n'), /Expected one of: CREATE, MODIFY, DELETE, READ, PATCH/);

    const lowerIntent = validateExternalAgentInput(JSON.stringify({
      actions: [{ path: 'a.ts', operation: 'CREATE', intent: 'mutate' }],
    }));
    assert.equal(lowerIntent.ok, false);
    assert.match(lowerIntent.errors.join('\n'), /Expected one of: MUTATE, NOOP, UNKNOWN/);
  });

  it('rejects unknown and mistyped nested JSON fields instead of silently dropping them', () => {
    const unknownAction = validateExternalAgentInput(JSON.stringify({
      actions: [{ path: 'a.ts', operation: 'CREATE', conten: 'typo' }],
    }));
    assert.equal(unknownAction.ok, false);
    assert.match(unknownAction.errors.join('\n'), /Unknown action key "conten"/);
    assert.match(unknownAction.errors.join('\n'), /Did you mean "content"/);

    const unknownAgent = validateExternalAgentInput(JSON.stringify({
      agent: { moddle: 'x' },
      actions: [{ path: 'a.ts', operation: 'CREATE' }],
    }));
    assert.equal(unknownAgent.ok, false);
    assert.match(unknownAgent.errors.join('\n'), /Unknown agent key "moddle"/);

    const invalidMetadata = validateExternalAgentInput(JSON.stringify({
      metadata: [],
      actions: [{ path: 'a.ts', operation: 'CREATE' }],
    }));
    assert.equal(invalidMetadata.ok, false);
    assert.match(invalidMetadata.errors.join('\n'), /metadata must be an object/);
  });

  it('rejects mixed envelope shapes and empty action arrays', () => {
    const mixed = validateExternalAgentInput(JSON.stringify({
      actions: [{ path: 'a.ts', operation: 'CREATE' }],
      output: 'ignored before phase 3',
    }));
    assert.equal(mixed.ok, false);
    assert.match(mixed.errors.join('\n'), /Unknown external-agent envelope key "output"/);

    const empty = validateExternalAgentInput(JSON.stringify([]));
    assert.equal(empty.ok, false);
    assert.match(empty.errors.join('\n'), /No valid file actions/);
  });

});

  it('accepts PATCH actions with old and new spans', () => {
    const envelope = parseExternalAgentEnvelope(JSON.stringify({
      actions: [{
        path: 'src/lib.ts',
        operation: 'PATCH',
        description: 'rename',
        old: 'foo',
        new: 'bar',
      }],
    }));
    assert.equal(envelope.actions[0]!.operation, 'PATCH');
    assert.equal(envelope.actions[0]!.old, 'foo');
    assert.equal(envelope.actions[0]!.new, 'bar');
  });

  it('rejects PATCH actions missing old or new', () => {
    assert.throws(
      () => parseExternalAgentEnvelope(JSON.stringify({
        actions: [{ path: 'a.ts', operation: 'PATCH', description: 'bad', old: 'x' }],
      })),
      /both old and new/i,
    );
  });
