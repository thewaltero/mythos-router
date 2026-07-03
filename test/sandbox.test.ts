import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runActionsInSandbox } from '../src/sandbox.js';
import type { FileAction } from '../src/swd.js';

function makeProject(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mythos-sandbox-test-'));
  writeFileSync(join(dir, 'index.txt'), 'original\n');
  mkdirSync(join(dir, 'src'));
  writeFileSync(join(dir, 'src', 'a.txt'), 'a\n');
  return dir;
}

describe('runActionsInSandbox', () => {
  it('applies actions in the copy and never touches the real tree', async () => {
    const dir = makeProject();
    try {
      const actions: FileAction[] = [
        { path: 'index.txt', operation: 'MODIFY', intent: 'MUTATE', content: 'changed in sandbox\n', description: 'edit' },
        { path: 'src/new.txt', operation: 'CREATE', intent: 'MUTATE', content: 'new\n', description: 'create' },
      ];

      const result = await runActionsInSandbox(actions, { cwd: dir, checks: [] });

      assert.equal(result.ok, true);
      assert.equal(result.ranChecks, false);
      assert.ok(result.filesCopied >= 2);
      // Real tree is untouched.
      assert.equal(readFileSync(join(dir, 'index.txt'), 'utf-8'), 'original\n');
      assert.equal(existsSync(join(dir, 'src', 'new.txt')), false);
      // Sandbox is cleaned up (no leftover temp dirs leak through the result).
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('uses SWDEngine semantics: CREATE cannot overwrite an existing sandbox file', async () => {
    const dir = makeProject();
    try {
      const result = await runActionsInSandbox(
        [{ path: 'index.txt', operation: 'CREATE', intent: 'MUTATE', content: 'overwrite\n', description: 'bad create' }],
        { cwd: dir, checks: [{ name: 'should-not-run', command: 'exit 0' }] },
      );

      assert.equal(result.ok, false);
      assert.equal(result.checks.length, 0);
      assert.match(result.setupError ?? '', /already exists/);
      assert.equal(readFileSync(join(dir, 'index.txt'), 'utf-8'), 'original\n');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('uses SWDEngine semantics: MODIFY cannot create a missing sandbox file', async () => {
    const dir = makeProject();
    try {
      const result = await runActionsInSandbox(
        [{ path: 'src/missing.txt', operation: 'MODIFY', intent: 'MUTATE', content: 'new\n', description: 'bad modify' }],
        { cwd: dir, checks: [{ name: 'should-not-run', command: 'exit 0' }] },
      );

      assert.equal(result.ok, false);
      assert.equal(result.checks.length, 0);
      assert.match(result.setupError ?? '', /does not exist/);
      assert.equal(existsSync(join(dir, 'src', 'missing.txt')), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports ok=true when a declared check passes', async () => {
    const dir = makeProject();
    try {
      const result = await runActionsInSandbox(
        [{ path: 'index.txt', operation: 'MODIFY', intent: 'MUTATE', content: 'x\n', description: 'edit' }],
        { cwd: dir, checks: [{ name: 'echo', command: 'exit 0' }] },
      );
      assert.equal(result.ok, true);
      assert.equal(result.ranChecks, true);
      assert.equal(result.checks.length, 1);
      assert.equal(result.checks[0]!.passed, true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports ok=false when a declared check fails (fail-closed signal)', async () => {
    const dir = makeProject();
    try {
      const result = await runActionsInSandbox(
        [{ path: 'index.txt', operation: 'MODIFY', intent: 'MUTATE', content: 'x\n', description: 'edit' }],
        { cwd: dir, checks: [{ name: 'fail', command: 'exit 1' }] },
      );
      assert.equal(result.ok, false);
      assert.equal(result.checks[0]!.passed, false);
      // Real tree still untouched even though we applied + checked.
      assert.equal(readFileSync(join(dir, 'index.txt'), 'utf-8'), 'original\n');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the check actually observes the sandboxed change, not the original', async () => {
    const dir = makeProject();
    try {
      // The check greps for content that only exists after the sandboxed edit.
      const result = await runActionsInSandbox(
        [{ path: 'index.txt', operation: 'MODIFY', intent: 'MUTATE', content: 'SENTINEL_VALUE\n', description: 'edit' }],
        { cwd: dir, checks: [{ name: 'grep', command: 'grep -q SENTINEL_VALUE index.txt' }] },
      );
      assert.equal(result.ok, true);
      assert.equal(result.checks[0]!.passed, true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('stops at the first failing check (fail-fast)', async () => {
    const dir = makeProject();
    try {
      const result = await runActionsInSandbox(
        [{ path: 'index.txt', operation: 'MODIFY', intent: 'MUTATE', content: 'x\n', description: 'edit' }],
        {
          cwd: dir,
          checks: [
            { name: 'first', command: 'exit 1' },
            { name: 'second', command: 'exit 0' },
          ],
        },
      );
      assert.equal(result.ok, false);
      assert.equal(result.checks.length, 1); // second never ran
      assert.equal(result.checks[0]!.name, 'first');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('jails traversal paths even if upstream validation is bypassed', async () => {
    const dir = makeProject();
    // A sentinel OUTSIDE the project that a traversal write would try to clobber.
    const outside = mkdtempSync(join(tmpdir(), 'mythos-sandbox-outside-'));
    const victim = join(outside, 'victim.txt');
    writeFileSync(victim, 'do-not-touch\n');
    try {
      // Construct a malicious action directly against the sandbox API,
      // simulating a bypass of assertSafeRelativePath / parseActions.
      const evil: FileAction = {
        path: '../../../../../../../../../../tmp/should-never-be-written.txt',
        operation: 'CREATE',
        intent: 'MUTATE',
        content: 'pwned\n',
        description: 'traversal attempt',
      };

      const result = await runActionsInSandbox([evil], { cwd: dir, checks: [] });

      // The sandbox apply must fail closed: jail violation surfaces as setupError.
      assert.equal(result.ok, false);
      assert.ok(result.setupError && /jail/i.test(result.setupError), `expected jail error, got: ${result.setupError}`);
      // The external sentinel is untouched, and no stray file was written to /tmp.
      assert.equal(readFileSync(victim, 'utf-8'), 'do-not-touch\n');
      assert.equal(existsSync('/tmp/should-never-be-written.txt'), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('skips project symlinks instead of importing outside target content', async (t) => {
    const dir = makeProject();
    const outside = mkdtempSync(join(tmpdir(), 'mythos-sandbox-symlink-outside-'));
    const externalSecret = join(outside, 'secret.txt');
    writeFileSync(externalSecret, 'outside-content\n');
    try {
      try {
        symlinkSync(externalSecret, join(dir, 'linked-secret.txt'), 'file');
      } catch {
        t.skip('File symlinks are not available in this environment');
        return;
      }

      const result = await runActionsInSandbox(
        [{ path: 'index.txt', operation: 'MODIFY', intent: 'MUTATE', content: 'x\n', description: 'edit' }],
        { cwd: dir, checks: [{ name: 'no-symlink-import', command: 'test ! -e linked-secret.txt' }] },
      );

      assert.equal(result.ok, true);
      assert.equal(result.checks[0]!.passed, true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('cleanup never deletes the real node_modules through the symlink', async () => {
    const dir = makeProject();
    // Simulate an installed dependency tree with a sentinel file.
    mkdirSync(join(dir, 'node_modules', 'left-pad'), { recursive: true });
    const sentinel = join(dir, 'node_modules', 'left-pad', 'index.js');
    writeFileSync(sentinel, 'module.exports = 1;\n');
    try {
      const result = await runActionsInSandbox(
        [{ path: 'index.txt', operation: 'MODIFY', intent: 'MUTATE', content: 'x\n', description: 'edit' }],
        // A check that depends on node_modules being visible inside the sandbox.
        { cwd: dir, checks: [{ name: 'dep-visible', command: 'test -f node_modules/left-pad/index.js' }] },
      );
      assert.equal(result.ok, true);
      assert.equal(result.checks[0]!.passed, true); // symlink made the dep visible
      // CRITICAL: the real node_modules sentinel must survive sandbox cleanup.
      assert.equal(existsSync(sentinel), true);
      assert.equal(readFileSync(sentinel, 'utf-8'), 'module.exports = 1;\n');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('handles DELETE inside the sandbox without touching the real file', async () => {
    const dir = makeProject();
    try {
      const result = await runActionsInSandbox(
        [{ path: 'src/a.txt', operation: 'DELETE', intent: 'MUTATE', description: 'delete' }],
        { cwd: dir, checks: [{ name: 'gone', command: 'test ! -e src/a.txt' }] },
      );
      assert.equal(result.ok, true);
      // Real file survives.
      assert.equal(existsSync(join(dir, 'src', 'a.txt')), true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  
    it('jails writes that resolve outside the sandbox via the node_modules symlink', async () => {
    const dir = makeProject();
    // Real node_modules lives OUTSIDE the sandbox; it is symlinked in so checks
    // can see deps. A write through that symlink must be rejected by the jail.
    mkdirSync(join(dir, 'node_modules'), { recursive: true });
    try {
      const result = await runActionsInSandbox(
        [{ path: 'node_modules/evil.txt', operation: 'CREATE', intent: 'MUTATE', content: 'pwned\n', description: 'symlink escape attempt' }],
        { cwd: dir, checks: [] },
      );

      // Fail-closed: the jailed resolver rejects the escaping path.
      assert.equal(result.ok, false);
      assert.ok(result.setupError && /jail/i.test(result.setupError), `expected jail error, got: ${result.setupError}`);
      // The real node_modules (outside the sandbox) is never written to.
      assert.equal(existsSync(join(dir, 'node_modules', 'evil.txt')), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('kills a check that exceeds the timeout and reports failure (no hang)', async () => {
    const dir = makeProject();
    try {
      const result = await runActionsInSandbox(
        [{ path: 'index.txt', operation: 'MODIFY', intent: 'MUTATE', content: 'x\n', description: 'edit' }],
        { cwd: dir, checks: [{ name: 'hang', command: 'sleep 30' }], checkTimeoutMs: 300 },
      );

      assert.equal(result.ok, false);
      assert.equal(result.checks[0]!.passed, false);
      assert.ok(/timeout/i.test(result.checks[0]!.outputTail), `expected timeout marker, got: ${result.checks[0]!.outputTail}`);
      // Real tree untouched because the gate did not pass.
      assert.equal(readFileSync(join(dir, 'index.txt'), 'utf-8'), 'original\n');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  
    it('never imports external content through a symlink in the project tree', async () => {
    const dir = makeProject();
    // A secret that lives OUTSIDE the project.
    const outside = mkdtempSync(join(tmpdir(), 'mythos-sandbox-outside-'));
    const externalSecret = join(outside, 'secret.txt');
    writeFileSync(externalSecret, 'TOP_SECRET_EXTERNAL_DATA\n');
    const externalDir = mkdtempSync(join(tmpdir(), 'mythos-sandbox-extdir-'));
    writeFileSync(join(externalDir, 'inside.txt'), 'EXTERNAL_DIR_CONTENT\n');

    // Plant symlinks inside the project pointing at the external file and dir.
    symlinkSync(externalSecret, join(dir, 'leak.txt'));
    symlinkSync(externalDir, join(dir, 'linkdir'));

    try {
      const result = await runActionsInSandbox(
        [{ path: 'index.txt', operation: 'MODIFY', intent: 'MUTATE', content: 'x\n', description: 'edit' }],
        {
          cwd: dir,
          checks: [
            // Inside the sandbox, neither symlink target should be reachable.
            { name: 'no-file-leak', command: 'test ! -e leak.txt' },
            { name: 'no-dir-leak', command: 'test ! -e linkdir/inside.txt' },
          ],
        },
      );

      // Symlinks are skipped entirely, so the checks (which assert absence) pass.
      assert.equal(result.ok, true);
      assert.equal(result.checks[0]!.passed, true);
      assert.equal(result.checks[1]!.passed, true);
      // The external secret is never read or copied; the real files are untouched.
      assert.equal(readFileSync(externalSecret, 'utf-8'), 'TOP_SECRET_EXTERNAL_DATA\n');
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
      rmSync(externalDir, { recursive: true, force: true });
    }
  });
});
