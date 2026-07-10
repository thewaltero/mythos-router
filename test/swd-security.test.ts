import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SWDEngine, type FileAction } from '../src/swd.js';

function makeWorkspace(prefix: string): { workspace: string; outside: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const workspace = join(root, 'workspace');
  const outside = join(root, 'outside');
  mkdirSync(workspace);
  mkdirSync(outside);
  return {
    workspace,
    outside,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function createDirectoryLink(target: string, linkPath: string): void {
  symlinkSync(target, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
}

describe('SWDEngine filesystem boundary hardening', () => {
  it('blocks CREATE through a symlinked ancestor even when nested parents are missing', async t => {
    const fixture = makeWorkspace('mythos-swd-symlink-');
    try {
      try {
        createDirectoryLink(fixture.outside, join(fixture.workspace, 'link'));
      } catch (error: unknown) {
        const code = error instanceof Error && 'code' in error ? error.code : undefined;
        if (code === 'EPERM' || code === 'EACCES') {
          t.skip('This environment does not permit creating directory links.');
          return;
        }
        throw error;
      }

      const escapedFile = join(fixture.outside, 'missing', 'escaped.txt');
      const engine = new SWDEngine({ rootDir: fixture.workspace, enableRollback: true });
      const result = await engine.run([{
        path: 'link/missing/escaped.txt',
        operation: 'CREATE',
        intent: 'MUTATE',
        content: 'must remain inside the repository',
      }]);

      assert.equal(result.success, false);
      assert.match(result.errors.join('\n'), /Symlink traversal/);
      assert.equal(existsSync(escapedFile), false, 'SWD wrote outside the configured root');
    } finally {
      fixture.cleanup();
    }
  });

  it('blocks MODIFY when the target itself is a symlink', async t => {
    const fixture = makeWorkspace('mythos-swd-target-link-');
    try {
      const outsideFile = join(fixture.outside, 'outside.txt');
      writeFileSync(outsideFile, 'original', 'utf8');
      try {
        symlinkSync(outsideFile, join(fixture.workspace, 'linked.txt'), 'file');
      } catch (error: unknown) {
        const code = error instanceof Error && 'code' in error ? error.code : undefined;
        if (code === 'EPERM' || code === 'EACCES') {
          t.skip('This environment does not permit creating file links.');
          return;
        }
        throw error;
      }

      const engine = new SWDEngine({ rootDir: fixture.workspace });
      const result = await engine.run([{
        path: 'linked.txt',
        operation: 'MODIFY',
        intent: 'MUTATE',
        content: 'unexpected mutation',
      }]);

      assert.equal(result.success, false);
      assert.match(result.errors.join('\n'), /Symlink traversal/);
      assert.equal(readFileSync(outsideFile, 'utf8'), 'original');
    } finally {
      fixture.cleanup();
    }
  });

  it('revalidates a missing parent immediately before mutation', async t => {
    const fixture = makeWorkspace('mythos-swd-revalidate-');
    try {
      let linkCreated = false;
      const engine = new SWDEngine({
        rootDir: fixture.workspace,
        onAction: () => {
          if (linkCreated) return;
          try {
            createDirectoryLink(fixture.outside, join(fixture.workspace, 'late-link'));
            linkCreated = true;
          } catch (error: unknown) {
            const code = error instanceof Error && 'code' in error ? error.code : undefined;
            if (code === 'EPERM' || code === 'EACCES') return;
            throw error;
          }
        },
      });

      const result = await engine.run([{
        path: 'late-link/nested/file.txt',
        operation: 'CREATE',
        intent: 'MUTATE',
        content: 'blocked',
      }]);

      if (!linkCreated) {
        t.skip('This environment does not permit creating directory links.');
        return;
      }

      assert.equal(result.success, false);
      assert.match(result.errors.join('\n'), /Symlink traversal/);
      assert.equal(existsSync(join(fixture.outside, 'nested', 'file.txt')), false);
    } finally {
      fixture.cleanup();
    }
  });

  it('rejects duplicate writable actions that resolve to the same canonical target', async () => {
    const fixture = makeWorkspace('mythos-swd-duplicates-');
    try {
      const target = join(fixture.workspace, 'same.txt');
      const actions: FileAction[] = [
        { path: 'same.txt', operation: 'CREATE', intent: 'MUTATE', content: 'first' },
        { path: target, operation: 'MODIFY', intent: 'MUTATE', content: 'second' },
      ];

      const result = await new SWDEngine({ rootDir: fixture.workspace }).run(actions);

      assert.equal(result.success, false);
      assert.match(result.errors.join('\n'), /Duplicate writable target/);
      assert.equal(existsSync(target), false, 'preflight failure must not touch disk');
    } finally {
      fixture.cleanup();
    }
  });

  it('rolls back a completed mutation when a post-write verification hook throws', async () => {
    const fixture = makeWorkspace('mythos-swd-hook-rollback-');
    try {
      const target = join(fixture.workspace, 'tracked.txt');
      writeFileSync(target, 'before', 'utf8');
      const engine = new SWDEngine({
        rootDir: fixture.workspace,
        enableRollback: true,
        onVerify: () => {
          throw new Error('verification observer failed');
        },
      });

      const result = await engine.run([{
        path: 'tracked.txt',
        operation: 'MODIFY',
        intent: 'MUTATE',
        content: 'after',
      }]);

      assert.equal(result.success, false);
      assert.equal(result.rolledBack, true);
      assert.equal(result.results[0]?.status, 'failed');
      assert.match(result.errors.join('\n'), /verification observer failed/);
      assert.equal(readFileSync(target, 'utf8'), 'before');
    } finally {
      fixture.cleanup();
    }
  });

  it('keeps the configured root stable if process.cwd changes later', async () => {
    const fixture = makeWorkspace('mythos-swd-root-');
    const other = mkdtempSync(join(tmpdir(), 'mythos-swd-other-'));
    const originalCwd = process.cwd();
    try {
      const engine = new SWDEngine({ rootDir: fixture.workspace });
      process.chdir(other);

      const result = await engine.run([{
        path: 'stable-root.txt',
        operation: 'CREATE',
        intent: 'MUTATE',
        content: 'root captured at construction',
      }]);

      assert.equal(result.success, true);
      assert.equal(readFileSync(join(fixture.workspace, 'stable-root.txt'), 'utf8'), 'root captured at construction');
      assert.equal(existsSync(join(other, 'stable-root.txt')), false);
    } finally {
      process.chdir(originalCwd);
      rmSync(other, { recursive: true, force: true });
      fixture.cleanup();
    }
  });
});
