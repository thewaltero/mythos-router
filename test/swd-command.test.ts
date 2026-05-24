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
