import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execSync, execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { mkdtempSync, existsSync } from 'node:fs';
import { join } from 'node:path';

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
    } catch (err: any) {
      assert.fail(
        `node dist/cli.js --help failed: ${err.message}\n${err.stdout ?? ''}\n${err.stderr ?? ''}`,
      );
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
});