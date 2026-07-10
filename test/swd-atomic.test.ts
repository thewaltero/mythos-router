import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AtomicFileWriter } from '../src/atomic-writer.js';
import { SWDEngine, type ActionResult, type FileAction } from '../src/swd.js';

function makeWorkspace(prefix: string): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), prefix));
  return {
    root,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function atomicTempFiles(directory: string): string[] {
  return readdirSync(directory).filter(name => name.startsWith('.mythos-atomic-'));
}

function readDriftAction(path: string): FileAction {
  return {
    path,
    operation: 'READ',
    intent: 'NOOP',
    contentHash: '0'.repeat(64),
    description: 'force strict verification drift without mutating disk',
  };
}

describe('AtomicFileWriter', () => {
  it('publishes CREATE and MODIFY content without leaving temporary files', () => {
    const fixture = makeWorkspace('mythos-atomic-success-');
    try {
      const target = join(fixture.root, 'file.txt');
      const writer = new AtomicFileWriter();

      writer.write(target, 'created', { createOnly: true });
      assert.equal(readFileSync(target, 'utf8'), 'created');
      assert.deepEqual(atomicTempFiles(fixture.root), []);

      if (process.platform !== 'win32') chmodSync(target, 0o640);
      const originalMode = statSync(target).mode;
      writer.write(target, 'modified', { createOnly: false, mode: originalMode });

      assert.equal(readFileSync(target, 'utf8'), 'modified');
      assert.deepEqual(atomicTempFiles(fixture.root), []);
      if (process.platform !== 'win32') {
        assert.equal(statSync(target).mode & 0o777, originalMode & 0o777);
      }
    } finally {
      fixture.cleanup();
    }
  });

  it('never overwrites a CREATE destination that appears before commit', () => {
    const fixture = makeWorkspace('mythos-atomic-create-race-');
    try {
      const target = join(fixture.root, 'raced.txt');
      const writer = new AtomicFileWriter();

      assert.throws(
        () => writer.write(target, 'mythos', {
          createOnly: true,
          beforeCommit: () => writeFileSync(target, 'external', 'utf8'),
        }),
        /Atomic write failed/,
      );

      assert.equal(readFileSync(target, 'utf8'), 'external');
      assert.deepEqual(atomicTempFiles(fixture.root), []);
    } finally {
      fixture.cleanup();
    }
  });

  it('removes its temporary file when atomic replacement fails', () => {
    const fixture = makeWorkspace('mythos-atomic-rename-fail-');
    try {
      const target = join(fixture.root, 'replace.txt');
      writeFileSync(target, 'before', 'utf8');
      const writer = new AtomicFileWriter();

      assert.throws(
        () => writer.write(target, 'after', {
          createOnly: false,
          mode: statSync(target).mode,
          beforeCommit: () => {
            rmSync(target);
            mkdirSync(target);
          },
        }),
        /Atomic write failed/,
      );

      assert.equal(statSync(target).isDirectory(), true);
      assert.deepEqual(atomicTempFiles(fixture.root), []);
    } finally {
      fixture.cleanup();
    }
  });
});

describe('SWDEngine atomic rollback outcomes', () => {
  it('reports a complete rollback after post-write verification failure', async () => {
    const fixture = makeWorkspace('mythos-rollback-complete-');
    try {
      const target = join(fixture.root, 'tracked.txt');
      writeFileSync(target, 'before', 'utf8');
      if (process.platform !== 'win32') chmodSync(target, 0o640);
      const originalMode = statSync(target).mode;

      const result = await new SWDEngine({ rootDir: fixture.root }).run([{
        path: 'tracked.txt',
        operation: 'MODIFY',
        intent: 'MUTATE',
        content: 'before',
        description: 'force no-op intent mismatch after an atomic replacement',
      }]);

      assert.equal(result.success, false);
      assert.equal(result.rolledBack, true);
      assert.equal(result.rollbackStatus, 'complete');
      assert.equal(result.recoveryRequired, false);
      assert.deepEqual(result.rollbackErrors, []);
      assert.equal(readFileSync(target, 'utf8'), 'before');
      assert.deepEqual(atomicTempFiles(fixture.root), []);
      if (process.platform !== 'win32') {
        assert.equal(statSync(target).mode & 0o777, originalMode & 0o777);
      }
    } finally {
      fixture.cleanup();
    }
  });

  it('reports failed rollback and manual recovery when every committed path drifts', async () => {
    const fixture = makeWorkspace('mythos-rollback-failed-');
    try {
      const target = join(fixture.root, 'tracked.txt');
      const trigger = join(fixture.root, 'trigger.txt');
      writeFileSync(target, 'before', 'utf8');
      writeFileSync(trigger, 'trigger', 'utf8');

      const result = await new SWDEngine({
        rootDir: fixture.root,
        onVerify: (verification: ActionResult) => {
          if (verification.action.path === 'trigger.txt' && verification.status === 'drift') {
            writeFileSync(target, 'external', 'utf8');
          }
        },
      }).run([
        {
          path: 'tracked.txt',
          operation: 'MODIFY',
          intent: 'MUTATE',
          content: 'mythos',
          description: 'committed mutation',
        },
        readDriftAction('trigger.txt'),
      ]);

      assert.equal(result.success, false);
      assert.equal(result.rolledBack, false);
      assert.equal(result.rollbackStatus, 'failed');
      assert.equal(result.recoveryRequired, true);
      assert.match(result.rollbackErrors.join('\n'), /Concurrency Drift/);
      assert.equal(readFileSync(target, 'utf8'), 'external');
    } finally {
      fixture.cleanup();
    }
  });

  it('reports partial rollback when one committed path restores and another drifts', async () => {
    const fixture = makeWorkspace('mythos-rollback-partial-');
    try {
      const first = join(fixture.root, 'first.txt');
      const second = join(fixture.root, 'second.txt');
      const trigger = join(fixture.root, 'trigger.txt');
      writeFileSync(first, 'first-before', 'utf8');
      writeFileSync(second, 'second-before', 'utf8');
      writeFileSync(trigger, 'trigger', 'utf8');

      const result = await new SWDEngine({
        rootDir: fixture.root,
        onVerify: (verification: ActionResult) => {
          if (verification.action.path === 'trigger.txt' && verification.status === 'drift') {
            writeFileSync(first, 'external', 'utf8');
          }
        },
      }).run([
        {
          path: 'first.txt',
          operation: 'MODIFY',
          intent: 'MUTATE',
          content: 'first-after',
          description: 'will drift before rollback',
        },
        {
          path: 'second.txt',
          operation: 'MODIFY',
          intent: 'MUTATE',
          content: 'second-after',
          description: 'will restore successfully',
        },
        readDriftAction('trigger.txt'),
      ]);

      assert.equal(result.success, false);
      assert.equal(result.rolledBack, true);
      assert.equal(result.rollbackStatus, 'partial');
      assert.equal(result.recoveryRequired, true);
      assert.match(result.rollbackErrors.join('\n'), /Concurrency Drift/);
      assert.equal(readFileSync(first, 'utf8'), 'external');
      assert.equal(readFileSync(second, 'utf8'), 'second-before');
      assert.deepEqual(atomicTempFiles(fixture.root), []);
    } finally {
      fixture.cleanup();
    }
  });

  it('reports disabled rollback when committed writes are intentionally left in place', async () => {
    const fixture = makeWorkspace('mythos-rollback-disabled-');
    try {
      const trigger = join(fixture.root, 'trigger.txt');
      writeFileSync(trigger, 'trigger', 'utf8');

      const result = await new SWDEngine({
        rootDir: fixture.root,
        enableRollback: false,
      }).run([
        {
          path: 'created.txt',
          operation: 'CREATE',
          intent: 'MUTATE',
          content: 'committed',
          description: 'left in place because rollback is disabled',
        },
        readDriftAction('trigger.txt'),
      ]);

      assert.equal(result.success, false);
      assert.equal(result.rolledBack, false);
      assert.equal(result.rollbackStatus, 'disabled');
      assert.equal(result.recoveryRequired, true);
      assert.match(result.rollbackErrors.join('\n'), /Manual recovery is required/);
      assert.equal(readFileSync(join(fixture.root, 'created.txt'), 'utf8'), 'committed');
    } finally {
      fixture.cleanup();
    }
  });

  it('refuses to overwrite a file changed after the before-snapshot', async () => {
    const fixture = makeWorkspace('mythos-precommit-drift-');
    try {
      const target = join(fixture.root, 'target.txt');
      writeFileSync(target, 'before', 'utf8');

      const result = await new SWDEngine({
        rootDir: fixture.root,
        onAction: () => writeFileSync(target, 'external', 'utf8'),
      }).run([{
        path: 'target.txt',
        operation: 'MODIFY',
        intent: 'MUTATE',
        content: 'mythos',
        description: 'must not overwrite a concurrent edit',
      }]);

      assert.equal(result.success, false);
      assert.equal(result.rolledBack, false);
      assert.equal(result.rollbackStatus, 'not-needed');
      assert.equal(result.recoveryRequired, false);
      assert.match(result.errors.join('\n'), /Concurrency Drift/);
      assert.equal(readFileSync(target, 'utf8'), 'external');
      assert.deepEqual(atomicTempFiles(fixture.root), []);
    } finally {
      fixture.cleanup();
    }
  });

  it('does not claim rollback work when verification fails without an SWD mutation', async () => {
    const fixture = makeWorkspace('mythos-rollback-none-');
    try {
      const target = join(fixture.root, 'target.txt');
      writeFileSync(target, 'unchanged', 'utf8');

      const result = await new SWDEngine({ rootDir: fixture.root }).run([
        readDriftAction('target.txt'),
      ]);

      assert.equal(result.success, false);
      assert.equal(result.rolledBack, false);
      assert.equal(result.rollbackStatus, 'not-needed');
      assert.equal(result.recoveryRequired, false);
      assert.deepEqual(result.rollbackErrors, []);
      assert.equal(readFileSync(target, 'utf8'), 'unchanged');
      assert.equal(existsSync(target), true);
    } finally {
      fixture.cleanup();
    }
  });
});
