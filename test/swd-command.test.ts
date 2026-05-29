import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

describe('mythos swd apply CLI', () => {
  it('applies stdin FILE_ACTION input as JSON without requiring provider keys', () => {
    const repoRoot = process.cwd();
    const tempDir = mkdtempSync(join(tmpdir(), 'mythos-swd-cli-'));
    const cliPath = join(repoRoot, 'src', 'cli.ts');
    const tsxLoader = pathToFileURL(join(repoRoot, 'node_modules', 'tsx', 'dist', 'loader.mjs')).href;
    const input = `
[FILE_ACTION: cli-created.txt]
OPERATION: CREATE
INTENT: MUTATE
CONTENT_HASH: ${sha256('created through cli')}
DESCRIPTION: Create through external-agent CLI
CONTENT:
created through cli
[/FILE_ACTION]
`;

    try {
      const env = { ...process.env };
      delete env.ANTHROPIC_API_KEY;
      delete env.OPENAI_API_KEY;
      delete env.DEEPSEEK_API_KEY;

      const output = execFileSync(
        process.execPath,
        ['--import', tsxLoader, cliPath, 'swd', 'apply', '--stdin', '--json', '--agent', 'pytest-agent', '--model', 'custom-model'],
        {
          cwd: tempDir,
          env,
          input,
          encoding: 'utf-8',
        },
      );
      const parsed = JSON.parse(output);

      assert.equal(parsed.ok, true);
      assert.equal(parsed.agent.id, 'pytest-agent');
      assert.equal(parsed.agent.model, 'custom-model');
      assert.equal(parsed.receipt.id.startsWith('swd-'), true);
      assert.equal(readFileSync(join(tempDir, 'cli-created.txt'), 'utf-8'), 'created through cli');
      assert.equal(existsSync(join(tempDir, '.mythos', 'receipts', `${parsed.receipt.id}.json`)), true);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('does not save receipts for CLI dry-runs by default', () => {
    const repoRoot = process.cwd();
    const tempDir = mkdtempSync(join(tmpdir(), 'mythos-swd-dry-no-receipt-'));
    const cliPath = join(repoRoot, 'src', 'cli.ts');
    const tsxLoader = pathToFileURL(join(repoRoot, 'node_modules', 'tsx', 'dist', 'loader.mjs')).href;
    const input = JSON.stringify({
      actions: [{ path: 'dry.txt', operation: 'CREATE', content: 'dry\n', description: 'dry create' }],
    });

    try {
      const output = execFileSync(
        process.execPath,
        ['--import', tsxLoader, cliPath, 'swd', 'apply', '--stdin', '--dry-run', '--json'],
        { cwd: tempDir, input, encoding: 'utf-8' },
      );
      const parsed = JSON.parse(output);

      assert.equal(parsed.ok, true);
      assert.equal(parsed.mode, 'dry-run');
      assert.equal(parsed.receipt, undefined);
      assert.equal(existsSync(join(tempDir, 'dry.txt')), false);
      assert.equal(existsSync(join(tempDir, '.mythos', 'receipts')), false);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('applies when an isolated --check passes and records the sandbox result', () => {
    const repoRoot = process.cwd();
    const tempDir = mkdtempSync(join(tmpdir(), 'mythos-swd-check-ok-'));
    const cliPath = join(repoRoot, 'src', 'cli.ts');
    const tsxLoader = pathToFileURL(join(repoRoot, 'node_modules', 'tsx', 'dist', 'loader.mjs')).href;
    const input = JSON.stringify({
      actions: [{ path: 'gated.txt', operation: 'CREATE', content: 'gated\n', description: 'gated create' }],
    });

    try {
      const output = execFileSync(
        process.execPath,
        ['--import', tsxLoader, cliPath, 'swd', 'apply', '--stdin', '--json', '--no-receipt', '--check', 'exit 0'],
        { cwd: tempDir, input, encoding: 'utf-8' },
      );
      const parsed = JSON.parse(output);

      assert.equal(parsed.ok, true);
      assert.equal(parsed.sandbox.ran, true);
      assert.equal(parsed.sandbox.ok, true);
      assert.equal(parsed.sandbox.checks[0].passed, true);
      // The file is written to the REAL tree only after checks pass.
      assert.equal(readFileSync(join(tempDir, 'gated.txt'), 'utf-8'), 'gated\n');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('does NOT touch the real tree when an isolated --check fails', () => {
    const repoRoot = process.cwd();
    const tempDir = mkdtempSync(join(tmpdir(), 'mythos-swd-check-fail-'));
    const cliPath = join(repoRoot, 'src', 'cli.ts');
    const tsxLoader = pathToFileURL(join(repoRoot, 'node_modules', 'tsx', 'dist', 'loader.mjs')).href;
    const input = JSON.stringify({
      actions: [{ path: 'should-not-exist.txt', operation: 'CREATE', content: 'nope\n', description: 'gated create' }],
    });

    try {
      let stdout = '';
      try {
        stdout = execFileSync(
          process.execPath,
          ['--import', tsxLoader, cliPath, 'swd', 'apply', '--stdin', '--json', '--no-receipt', '--check', 'exit 7'],
          { cwd: tempDir, input, encoding: 'utf-8' },
        );
        assert.fail('failed checks should exit non-zero');
      } catch (err: any) {
        stdout = err.stdout;
        assert.equal(err.status, 1);
      }

      const parsed = JSON.parse(stdout);
      assert.equal(parsed.ok, false);
      assert.equal(parsed.sandbox.ok, false);
      assert.equal(parsed.sandbox.checks[0].passed, false);
      // Fail-closed: the real working tree was never modified.
      assert.equal(existsSync(join(tempDir, 'should-not-exist.txt')), false);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('returns machine-readable failure for blocked sensitive files', () => {
    const repoRoot = process.cwd();
    const tempDir = mkdtempSync(join(tmpdir(), 'mythos-swd-cli-block-'));
    const cliPath = join(repoRoot, 'src', 'cli.ts');
    const tsxLoader = pathToFileURL(join(repoRoot, 'node_modules', 'tsx', 'dist', 'loader.mjs')).href;
    const input = JSON.stringify({
      actions: [{
        path: '.env',
        operation: 'CREATE',
        content: 'API_KEY=do-not-write',
        description: 'Blocked secret write',
      }],
    });

    try {
      let stdout = '';
      try {
        stdout = execFileSync(
          process.execPath,
          ['--import', tsxLoader, cliPath, 'swd', 'apply', '--stdin', '--json'],
          {
            cwd: tempDir,
            input,
            encoding: 'utf-8',
          },
        );
        assert.fail('blocked action should exit non-zero');
      } catch (err: any) {
        stdout = err.stdout;
      }

      const parsed = JSON.parse(stdout);
      assert.equal(parsed.ok, false);
      assert.equal(parsed.rejected[0].risk, 'block');
      assert.equal(existsSync(join(tempDir, '.env')), false);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
