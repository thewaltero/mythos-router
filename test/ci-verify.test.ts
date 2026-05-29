import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { runCIVerification } from '../src/ci/verify.js';
import { createSWDReceipt, saveSWDReceipt } from '../src/receipts.js';
import type { SWDRunResult } from '../src/swd.js';

function git(cwd: string, args: string[]): void {
  execFileSync('git', ['-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args], {
    cwd,
    stdio: 'ignore',
  });
}

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mythos-ci-verify-'));
  git(dir, ['init']);
  git(dir, ['config', 'user.email', 'test@example.com']);
  git(dir, ['config', 'user.name', 'Mythos Test']);
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    name: 'fixture',
    version: '1.0.0',
    scripts: {
      test: 'node test.js',
    },
  }, null, 2));
  mkdirSync(join(dir, 'src'));
  writeFileSync(join(dir, 'src', 'index.ts'), 'export const ok = true;\n');
  git(dir, ['add', '.']);
  git(dir, ['commit', '-m', 'initial']);
  return dir;
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

describe('mythos verify --ci', () => {
  it('runs generic PR review without requiring Mythos receipts', () => {
    const dir = makeRepo();
    try {
      writeFileSync(join(dir, 'src', 'index.ts'), 'export const ok = false;\n');
      const report = runCIVerification({ cwd: dir });

      assert.equal(report.mode, 'generic');
      assert.equal(report.summary.exitCode, 0);
      assert.equal(report.findings.length, 0);
      assert.equal(report.changedFiles.some((file) => file.path === 'src/index.ts'), true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails on newly added npm install lifecycle scripts', () => {
    const dir = makeRepo();
    try {
      writeFileSync(join(dir, 'package.json'), JSON.stringify({
        name: 'fixture',
        version: '1.0.0',
        scripts: {
          test: 'node test.js',
          postinstall: 'node scripts/setup.js',
        },
      }, null, 2));

      const report = runCIVerification({ cwd: dir });
      assert.equal(report.summary.exitCode, 1);
      assert.equal(report.summary.high, 1);
      assert.ok(report.findings.some((finding) => finding.id === 'npm-lifecycle-script-added'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails in strict mode when only warnings are present', () => {
    const dir = makeRepo();
    try {
      mkdirSync(join(dir, '.github', 'workflows'), { recursive: true });
      writeFileSync(join(dir, '.github', 'workflows', 'ci.yml'), 'name: CI\n');

      const relaxed = runCIVerification({ cwd: dir });
      assert.equal(relaxed.summary.warn, 1);
      assert.equal(relaxed.summary.exitCode, 0);

      const strict = runCIVerification({ cwd: dir, strict: true });
      assert.equal(strict.summary.warn, 1);
      assert.equal(strict.summary.exitCode, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('warns when Mythos project policy changes', () => {
    const dir = makeRepo();
    try {
      mkdirSync(join(dir, '.mythos'), { recursive: true });
      writeFileSync(join(dir, '.mythos', 'policy.json'), JSON.stringify({
        version: 1,
        block: ['infra/prod/**'],
      }, null, 2));

      const report = runCIVerification({ cwd: dir });
      assert.equal(report.summary.warn, 1);
      assert.equal(report.summary.exitCode, 0);
      assert.ok(report.findings.some((finding) => finding.id === 'mythos-policy-changed'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('uses Mythos receipt verification when a receipt is changed in the diff', () => {
    const repoRoot = process.cwd();
    const dir = makeRepo();
    try {
      const filePath = 'src/index.ts';
      const absPath = join(dir, filePath);
      const after = 'export const ok = "receipt-covered";\n';
      writeFileSync(absPath, after);

      process.chdir(dir);
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
              description: 'Update test fixture',
            },
            status: 'verified',
            detail: `Verified: MODIFY ${filePath}`,
            before: {
              path: absPath,
              exists: true,
              size: 'export const ok = true;\n'.length,
              mtime: 1,
              hash: sha256('export const ok = true;\n'),
            },
            after: {
              path: absPath,
              exists: true,
              size: after.length,
              mtime: 2,
              hash: sha256(after),
            },
          },
        ],
      };
      const receipt = createSWDReceipt({
        request: 'update fixture',
        summary: `MODIFY: ${filePath}`,
        result: runResult,
      });
      saveSWDReceipt(receipt);
      process.chdir(repoRoot);

      const report = runCIVerification({ cwd: dir });
      assert.equal(report.mode, 'mythos-receipts');
      assert.equal(report.receipt.changedReceiptCount, 1);
      assert.equal(report.receipt.validReceiptCount, 1);
      assert.equal(report.receipt.uncoveredChangedFiles.length, 0);
      assert.equal(report.summary.exitCode, 0);
    } finally {
      process.chdir(repoRoot);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
