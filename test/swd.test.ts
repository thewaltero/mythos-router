import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, unlinkSync, mkdirSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  parseActions,
  resolveSafePath,
  snapshotFile,
  SWDEngine,
  MAX_WRITABLE_ACTION_CONTENT_BYTES,
  type FileAction,
} from '../src/swd.js';

describe('parseActions', () => {
  it('parses a valid CREATE action block', () => {
    const output = `
[FILE_ACTION: src/hello.ts]
OPERATION: CREATE
INTENT: MUTATE
CONTENT_HASH: abc123def456
DESCRIPTION: Create hello module
[/FILE_ACTION]
`;
    const actions = parseActions(output);
    assert.equal(actions.length, 1);
    assert.equal(actions[0]!.path, 'src/hello.ts');
    assert.equal(actions[0]!.operation, 'CREATE');
    assert.equal(actions[0]!.intent, 'MUTATE');
    assert.equal(actions[0]!.contentHash, 'abc123def456');
    assert.equal(actions[0]!.description, 'Create hello module');
  });

  it('defaults intent to MUTATE if omitted', () => {
    const output = `
[FILE_ACTION: src/test.ts]
OPERATION: MODIFY
DESCRIPTION: No intent provided
[/FILE_ACTION]
`;
    const actions = parseActions(output);
    assert.equal(actions[0]!.intent, 'MUTATE');
  });
});

describe('SWDEngine (Production v1 API)', () => {
  const testDir = join(process.cwd(), 'test', '.tmp-swd-engine');

  it('Success: Plan → Execute → Verify sequentially', async () => {
    mkdirSync(testDir, { recursive: true });
    const fileA = join(testDir, 'engine-success.txt');
    const engine = new SWDEngine();

    const actions: FileAction[] = [{
      path: fileA,
      operation: 'CREATE',
      intent: 'MUTATE',
      content: 'hello engine',
      description: 'sequential test'
    }];

    const result = await engine.run(actions);
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.results[0]?.status, 'verified');
    assert.strictEqual(readFileSync(fileA, 'utf-8'), 'hello engine');

    rmSync(testDir, { recursive: true, force: true });
  });

  it('Failure: Trigger rollback on intent mismatch (MUTATE → NOOP)', async () => {
    mkdirSync(testDir, { recursive: true });
    const fileA = join(testDir, 'rollback-intent.txt');
    writeFileSync(fileA, 'initial', 'utf-8');

    const engine = new SWDEngine({ enableRollback: true });
    
    const actions: FileAction[] = [{
      path: fileA,
      operation: 'MODIFY',
      intent: 'MUTATE',
      content: 'initial', // NO CHANGE
      description: 'failure case'
    }];

    const result = await engine.run(actions);
    assert.strictEqual(result.success, false);
    assert.strictEqual(result.results[0]?.status, 'failed');
    assert.strictEqual(result.rolledBack, true);
    assert.strictEqual(readFileSync(fileA, 'utf-8'), 'initial');

    rmSync(testDir, { recursive: true, force: true });
  });

  it('Failure: Trigger rollback on declared-hash mismatch with no inlined content (Drift)', async () => {
    mkdirSync(testDir, { recursive: true });
    const fileA = join(testDir, 'rollback-drift.txt');
    writeFileSync(fileA, 'initial', 'utf-8');

    const engine = new SWDEngine({ strict: true, enableRollback: true });

    // External-agent style action: asserts an expected post-write SHA-256
    // without inlining content. Disk does not match the declared hash, so
    // SWD must flag drift. (When content IS inlined, SWD verifies against the
    // content itself and ignores any declared hash.)
    const actions: FileAction[] = [{
      path: fileA,
      operation: 'MODIFY',
      intent: 'MUTATE',
      contentHash: 'wrong_hash',
      description: 'drift test'
    }];

    const result = await engine.run(actions);
    assert.strictEqual(result.success, false);
    assert.strictEqual(result.results[0]?.status, 'drift');

    rmSync(testDir, { recursive: true, force: true });
  });

  it('Hardening: Detects and respects concurrency drift during rollback', async () => {
    mkdirSync(testDir, { recursive: true });
    const fileA = join(testDir, 'concurrency.txt');
    writeFileSync(fileA, 'initial', 'utf-8');

    const engine = new SWDEngine({
      strict: true,
      enableRollback: true,
      onVerify: () => {
        writeFileSync(fileA, 'external-change', 'utf-8');
      },
    });

    const result = await engine.run([{
      path: fileA,
      operation: 'MODIFY',
      intent: 'MUTATE',
      contentHash: 'wrong_hash',
      description: 'drift with external edit before rollback'
    }]);

    assert.strictEqual(result.success, false);
    assert.strictEqual(result.results[0]?.status, 'drift');
    assert.strictEqual(result.rolledBack, false);
    assert.match(result.rollbackErrors[0] ?? '', /Concurrency Drift/);
    assert.strictEqual(readFileSync(fileA, 'utf-8'), 'external-change');

    rmSync(testDir, { recursive: true, force: true });
  });

  it('Dry-run mode: Does NOT modify disk and labels writes as planned', async () => {
    mkdirSync(testDir, { recursive: true });
    const fileA = join(testDir, 'dryrun.txt');
    const engine = new SWDEngine({ dryRun: true });

    const result = await engine.run([{
      path: fileA,
      operation: 'CREATE',
      intent: 'MUTATE',
      content: 'should not exist',
      description: 'dry run test'
    }]);

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.results[0]?.detail, `Dry-run: planned CREATE ${fileA} (not applied)`);
    assert.strictEqual(existsSync(fileA), false);

    rmSync(testDir, { recursive: true, force: true });
  });

  it('Hardening: Blocks oversized full-file writes before touching disk', async () => {
    mkdirSync(testDir, { recursive: true });
    const safeFile = join(testDir, 'safe-before-large.txt');
    const largeFile = join(testDir, 'large-write.txt');
    const engine = new SWDEngine();

    const result = await engine.run([
      {
        path: safeFile,
        operation: 'CREATE',
        intent: 'MUTATE',
        content: 'this should not be written when a later action is oversized',
        description: 'safe action that must be preflight-blocked'
      },
      {
        path: largeFile,
        operation: 'CREATE',
        intent: 'MUTATE',
        content: 'x'.repeat(MAX_WRITABLE_ACTION_CONTENT_BYTES + 1),
        description: 'oversized write'
      }
    ]);

    assert.strictEqual(result.success, false);
    assert.match(result.errors[0] ?? '', /Large full-file writes are blocked/);
    assert.strictEqual(existsSync(safeFile), false);
    assert.strictEqual(existsSync(largeFile), false);

    rmSync(testDir, { recursive: true, force: true });
  });

  it('Creates files inside a non-existent nested directory', async () => {
    mkdirSync(testDir, { recursive: true });
    const nested = join(testDir, 'newdir', 'deep', 'nested.txt');
    const engine = new SWDEngine();

    const result = await engine.run([{
      path: nested,
      operation: 'CREATE',
      intent: 'MUTATE',
      content: 'created in a fresh directory',
      description: 'nested create'
    }]);

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.results[0]?.status, 'verified');
    assert.strictEqual(existsSync(nested), true);
    assert.strictEqual(readFileSync(nested, 'utf-8'), 'created in a fresh directory');

    rmSync(testDir, { recursive: true, force: true });
  });

  it('Rolls back earlier writes when a later action throws during execution', async () => {
    mkdirSync(testDir, { recursive: true });
    const fileA = join(testDir, 'exec-rollback-a.txt');
    const fileB = join(testDir, 'exec-rollback-b.txt');
    // fileB already exists, so the second CREATE will throw mid-batch.
    writeFileSync(fileB, 'pre-existing', 'utf-8');

    const engine = new SWDEngine({ enableRollback: true });

    const result = await engine.run([
      {
        path: fileA,
        operation: 'CREATE',
        intent: 'MUTATE',
        content: 'should be rolled back',
        description: 'first action that succeeds'
      },
      {
        path: fileB,
        operation: 'CREATE',
        intent: 'MUTATE',
        content: 'never written',
        description: 'second action that throws (already exists)'
      }
    ]);

    assert.strictEqual(result.success, false);
    assert.strictEqual(result.rolledBack, true);
    assert.match(result.errors.join('\n'), /already exists/);
    // The earlier successful write must be undone.
    assert.strictEqual(existsSync(fileA), false);
    // The pre-existing file must be untouched.
    assert.strictEqual(readFileSync(fileB, 'utf-8'), 'pre-existing');

    rmSync(testDir, { recursive: true, force: true });
  });

  it('Blocks MODIFY of a file larger than the rollback snapshot cap', async () => {
    mkdirSync(testDir, { recursive: true });
    const big = join(testDir, 'big.txt');
    writeFileSync(big, 'X'.repeat(100), 'utf-8'); // 100 bytes
    const engine = new SWDEngine({ maxSnapshotBytes: 10 }); // cap below file size

    const result = await engine.run([{
      path: big,
      operation: 'MODIFY',
      intent: 'MUTATE',
      content: 'replacement',
      description: 'modify an oversized file'
    }]);

    assert.strictEqual(result.success, false);
    assert.strictEqual(result.rolledBack, false);
    assert.match(result.errors.join('\n'), /rollback snapshot cap/);
    // Original content untouched — we never even opened it for writing.
    assert.strictEqual(readFileSync(big, 'utf-8'), 'X'.repeat(100));

    rmSync(testDir, { recursive: true, force: true });
  });
});

describe('parseActions intent defaults', () => {
  it('defaults a READ block without an INTENT line to NOOP', () => {
    const output = [
      '[FILE_ACTION: src/read-me.ts]',
      'OPERATION: READ',
      'DESCRIPTION: inspect a file',
      '[/FILE_ACTION]',
    ].join('\n');

    const actions = parseActions(output);
    assert.strictEqual(actions.length, 1);
    assert.strictEqual(actions[0].operation, 'READ');
    assert.strictEqual(actions[0].intent, 'NOOP');
  });

  it('still defaults a CREATE block without an INTENT line to MUTATE', () => {
    const output = [
      '[FILE_ACTION: src/new.ts]',
      'OPERATION: CREATE',
      'DESCRIPTION: add a file',
      'CONTENT:',
      'export const x = 1;',
      '[/FILE_ACTION]',
    ].join('\n');

    const actions = parseActions(output);
    assert.strictEqual(actions[0].intent, 'MUTATE');
  });
});
