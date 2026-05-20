import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execSync, execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { mkdtempSync, existsSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createSWDReceipt, saveSWDReceipt } from '../src/receipts.js';
import type { SWDRunResult } from '../src/swd.js';

describe('CLI Smoke Tests', () => {
  it('builds the project without errors', () => {
    try {
      execSync('npm run build', {
        encoding: 'utf-8',
        stdio: 'inherit',
      });
    } catch (err: any) {
      assert.fail(`npm run build failed: ${err.message}`);
    }
  });

  it('runs --help on the built CLI', () => {
    try {
      const output = execFileSync(process.execPath, ['dist/cli.js', '--help'], {
        encoding: 'utf-8',
      });

      assert.ok(output.includes('Usage: mythos [options] [command]'));
      assert.ok(output.includes('chat [options]'));
      assert.ok(output.includes('run [options]'));
      assert.ok(output.includes('skills [options]'));
      assert.ok(output.includes('init [options]'));
    } catch (err: any) {
      assert.fail(
        `node dist/cli.js --help failed: ${err.message}\n${err.stdout ?? ''}\n${err.stderr ?? ''}`,
      );
    }
  });

  it('lists one-shot prompt source options in run help', () => {
    try {
      const output = execFileSync(process.execPath, ['dist/cli.js', 'run', '--help'], {
        encoding: 'utf-8',
      });

      assert.ok(output.includes('[prompt...]'));
      assert.ok(output.includes('--file <path>'));
      assert.ok(output.includes('--stdin'));
    } catch (err: any) {
      assert.fail(
        `node dist/cli.js run --help failed: ${err.message}\n${err.stdout ?? ''}\n${err.stderr ?? ''}`,
      );
    }
  });

  it('runs init --check in a temporary directory without creating project files', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'mythos-init-check-'));
    const cliPath = join(process.cwd(), 'dist', 'cli.js');

    try {
      const output = execFileSync(
        process.execPath,
        [cliPath, 'init', '--check'],
        {
          cwd: tempDir,
          encoding: 'utf-8',
        },
      );

      assert.ok(output.includes('PROJECT CHECK'));

      assert.equal(
        existsSync(join(tempDir, '.mythosignore')),
        false,
        'init --check should not create .mythosignore',
      );

      assert.equal(
        existsSync(join(tempDir, 'MEMORY.md')),
        false,
        'init --check should not create MEMORY.md',
      );

      assert.equal(
        existsSync(join(tempDir, '.mythos')),
        false,
        'init --check should not create .mythos',
      );
    } catch (err: any) {
      assert.fail(
        `init --check failed: ${err.message}\n${err.stdout ?? ''}\n${err.stderr ?? ''}`,
      );
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('runs skills list and check in a temporary directory without creating project files', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'mythos-skills-cli-'));
    const globalDir = mkdtempSync(join(tmpdir(), 'mythos-skills-cli-global-'));
    const cliPath = join(process.cwd(), 'dist', 'cli.js');
    const env = { ...process.env, MYTHOS_SKILLS_DIR: globalDir };

    try {
      const listed = JSON.parse(execFileSync(
        process.execPath,
        [cliPath, 'skills', '--json'],
        { cwd: tempDir, env, encoding: 'utf-8' },
      ));
      assert.deepEqual(listed, []);

      const checked = JSON.parse(execFileSync(
        process.execPath,
        [cliPath, 'skills', 'check', '--json'],
        { cwd: tempDir, env, encoding: 'utf-8' },
      ));
      assert.equal(checked.ok, true);
      assert.equal(checked.checked, 0);

      assert.equal(
        existsSync(join(tempDir, '.mythos')),
        false,
        'skills list/check should not create .mythos',
      );
    } catch (err: any) {
      assert.fail(
        `skills CLI smoke failed: ${err.message}\n${err.stdout ?? ''}\n${err.stderr ?? ''}`,
      );
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
      rmSync(globalDir, { recursive: true, force: true });
    }
  });

  it('runs verify --dry-run in a temporary directory without creating memory files', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'mythos-test-'));
    const cliPath = join(process.cwd(), 'dist', 'cli.js');

    try {
      const output = execFileSync(
        process.execPath,
        [cliPath, 'verify', '--dry-run'],
        {
          cwd: tempDir,
          encoding: 'utf-8',
        },
      );

      assert.ok(output.includes('Memory writes will be previewed'));

      assert.equal(
        existsSync(join(tempDir, 'MEMORY.md')),
        false,
        'verify --dry-run should not create MEMORY.md',
      );

      assert.equal(
        existsSync(join(tempDir, 'memory.db')),
        false,
        'verify --dry-run should not create memory.db',
      );

      assert.equal(
        existsSync(join(tempDir, 'memory.db-shm')),
        false,
        'verify --dry-run should not create memory.db-shm',
      );

      assert.equal(
        existsSync(join(tempDir, 'memory.db-wal')),
        false,
        'verify --dry-run should not create memory.db-wal',
      );
    } catch (err: any) {
      assert.fail(
        `verify --dry-run failed: ${err.message}\n${err.stdout ?? ''}\n${err.stderr ?? ''}`,
      );
    }
  });

  it('runs dream --dry-run in a temporary directory without creating memory files', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'mythos-test-'));
    const cliPath = join(process.cwd(), 'dist', 'cli.js');

    try {
      const output = execFileSync(
        process.execPath,
        [cliPath, 'dream', '--dry-run'],
        {
          cwd: tempDir,
          encoding: 'utf-8',
        },
      );

      assert.ok(output.includes('Memory writes will be previewed'));

      assert.equal(
        existsSync(join(tempDir, 'MEMORY.md')),
        false,
        'dream --dry-run should not create MEMORY.md',
      );

      assert.equal(
        existsSync(join(tempDir, 'memory.db')),
        false,
        'dream --dry-run should not create memory.db',
      );
    } catch (err: any) {
      assert.fail(
        `dream --dry-run failed: ${err.message}\n${err.stdout ?? ''}\n${err.stderr ?? ''}`,
      );
    }
  });

  it('runs receipts list, show, and verify on the built CLI', () => {
    const repoRoot = process.cwd();
    const tempDir = mkdtempSync(join(tmpdir(), 'mythos-receipts-cli-'));
    const cliPath = join(repoRoot, 'dist', 'cli.js');
    const filePath = 'sample.txt';
    const absPath = join(tempDir, filePath);

    try {
      process.chdir(tempDir);
      writeFileSync(absPath, 'after', 'utf-8');

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
              size: 'before'.length,
              mtime: 1,
              hash: sha256('before'),
            },
            after: {
              path: absPath,
              exists: true,
              size: 'after'.length,
              mtime: 2,
              hash: sha256('after'),
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
      });
      saveSWDReceipt(receipt);
      process.chdir(repoRoot);

      const listed = JSON.parse(execFileSync(
        process.execPath,
        [cliPath, 'receipts', '--json'],
        { cwd: tempDir, encoding: 'utf-8' },
      ));
      assert.equal(listed.length, 1);
      assert.equal(listed[0].id, receipt.id);

      const shown = JSON.parse(execFileSync(
        process.execPath,
        [cliPath, 'receipts', 'show', receipt.id, '--json'],
        { cwd: tempDir, encoding: 'utf-8' },
      ));
      assert.equal(shown.id, receipt.id);
      assert.equal(shown.files[0].path, filePath);
      assert.equal(shown.files[0].after.path, filePath);

      const verified = JSON.parse(execFileSync(
        process.execPath,
        [cliPath, 'receipts', 'verify', receipt.id, '--json'],
        { cwd: tempDir, encoding: 'utf-8' },
      ));
      assert.equal(verified.ok, true);
      assert.equal(verified.integrityOk, true);
      assert.equal(verified.files[0].status, 'ok');

      writeFileSync(absPath, 'changed', 'utf-8');
      const drifted = JSON.parse(execFileSync(
        process.execPath,
        [cliPath, 'receipts', 'verify', receipt.id, '--json'],
        { cwd: tempDir, encoding: 'utf-8' },
      ));
      assert.equal(drifted.ok, false);
      assert.equal(drifted.files[0].status, 'drifted');
    } catch (err: any) {
      assert.fail(
        `receipts CLI smoke failed: ${err.message}\n${err.stdout ?? ''}\n${err.stderr ?? ''}`,
      );
    } finally {
      process.chdir(repoRoot);
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}
