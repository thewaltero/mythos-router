import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { actionsFromToolCalls, parseActions } from '../src/swd.js';

describe('actionsFromToolCalls', () => {
  it('normalizes a single tool-call object into a FileAction', () => {
    const actions = actionsFromToolCalls({
      path: 'src/index.ts',
      operation: 'create',
      content: 'export const ok = true;\n',
      description: 'add entry',
    });
    assert.equal(actions.length, 1);
    assert.equal(actions[0].path, 'src/index.ts');
    assert.equal(actions[0].operation, 'CREATE'); // upper-cased
    assert.equal(actions[0].intent, 'MUTATE'); // default for non-READ
    assert.equal(actions[0].content, 'export const ok = true;\n');
    assert.equal(actions[0].description, 'add entry');
  });

  it('accepts an array and preserves order', () => {
    const actions = actionsFromToolCalls([
      { path: 'a.ts', operation: 'CREATE', content: 'a' },
      { path: 'b.ts', operation: 'MODIFY', content: 'b' },
      { path: 'c.ts', operation: 'DELETE' },
    ]);
    assert.deepEqual(actions.map((a) => `${a.operation} ${a.path}`), ['CREATE a.ts', 'MODIFY b.ts', 'DELETE c.ts']);
  });

  it('defaults description when absent and intent for READ', () => {
    const [read] = actionsFromToolCalls({ path: 'notes.md', operation: 'READ' });
    assert.equal(read.intent, 'NOOP'); // READ is inherently a no-op
    assert.equal(read.description, 'READ notes.md');
  });

  it('honours an explicit intent', () => {
    const [a] = actionsFromToolCalls({ path: 'x.ts', operation: 'MODIFY', intent: 'NOOP', content: 'same' });
    assert.equal(a.intent, 'NOOP');
  });

  it('applies the SAME path-safety rules as the text parser', () => {
    // Traversal, absolute, and null-byte paths are all rejected.
    assert.equal(actionsFromToolCalls({ path: '../escape.ts', operation: 'CREATE', content: 'x' }).length, 0);
    assert.equal(actionsFromToolCalls({ path: 'a/../../b.ts', operation: 'CREATE', content: 'x' }).length, 0);
    assert.equal(actionsFromToolCalls({ path: '/etc/passwd', operation: 'MODIFY', content: 'x' }).length, 0);
    assert.equal(actionsFromToolCalls({ path: 'bad\0.ts', operation: 'CREATE', content: 'x' }).length, 0);
    // …but a filename that merely contains '..' is allowed, matching the parser.
    assert.equal(actionsFromToolCalls({ path: 'backup..old.txt', operation: 'CREATE', content: 'x' }).length, 1);
  });

  it('drops entries with an unknown operation or missing fields', () => {
    assert.equal(actionsFromToolCalls({ path: 'a.ts', operation: 'RENAME', content: 'x' } as never).length, 0);
    assert.equal(actionsFromToolCalls({ path: '', operation: 'CREATE', content: 'x' }).length, 0);
    assert.equal(actionsFromToolCalls({ operation: 'CREATE', content: 'x' } as never).length, 0);
    assert.equal(actionsFromToolCalls([null, undefined, 42] as never).length, 0);
  });

  it('produces actions equivalent to the text-block parser for the same intent', () => {
    const fromText = parseActions(
      '[FILE_ACTION: src/app.ts]\nOPERATION: MODIFY\nINTENT: MUTATE\nDESCRIPTION: update\nCONTENT:\nhello\n[/FILE_ACTION]',
    );
    const fromTool = actionsFromToolCalls({
      path: 'src/app.ts',
      operation: 'MODIFY',
      intent: 'MUTATE',
      description: 'update',
      content: 'hello',
    });
    assert.equal(fromText.length, 1);
    assert.equal(fromTool.length, 1);
    assert.equal(fromTool[0].path, fromText[0].path);
    assert.equal(fromTool[0].operation, fromText[0].operation);
    assert.equal(fromTool[0].intent, fromText[0].intent);
    assert.equal(fromTool[0].content, fromText[0].content);
  });
});

  it('normalizes PATCH tool calls with old/new', () => {
    const [action] = actionsFromToolCalls({
      path: 'src/x.ts',
      operation: 'PATCH',
      old: 'a',
      new: 'b',
      description: 'patch',
    });
    assert.equal(action.operation, 'PATCH');
    assert.equal(action.old, 'a');
    assert.equal(action.new, 'b');
  });

  it('drops incomplete PATCH tool calls', () => {
    const actions = actionsFromToolCalls({
      path: 'src/x.ts',
      operation: 'PATCH',
      old: 'a',
      description: 'missing new',
    });
    assert.equal(actions.length, 0);
  });
