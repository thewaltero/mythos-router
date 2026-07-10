import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listRuns, readRun, saveRunRecord } from '../src/runs.js';
import type { SWDApplyResult } from '../src/commands/swd.js';

describe('run outcome ledger', () => {
  it('saves, lists, and reads local run records without storing file content', () => {
    const previousCwd = process.cwd();
    const tempDir = mkdtempSync(join(tmpdir(), 'mythos-runs-'));

    try {
      process.chdir(tempDir);
      const output: SWDApplyResult = {
        ok: true,
        mode: 'apply',
        actionCount: 1,
        approvedCount: 1,
        rejected: [],
        agent: { id: 'runs-agent', model: 'manual' },
        result: {
          success: true,
          rolledBack: false,
          rollbackErrors: [],
          rollbackStatus: 'not-needed',
          recoveryRequired: false,
          errors: [],
          results: [{
            action: {
              path: 'src/run.ts',
              operation: 'CREATE',
              intent: 'MUTATE',
              description: 'create run file',
              content: 'SECRET_API_KEY=do-not-store\n',
            },
            status: 'verified',
            detail: 'Verified: CREATE src/run.ts',
          }],
        },
      };

      const saved = saveRunRecord(output, { request: 'run smoke', summary: 'create run file' });
      assert.equal(existsSync(saved.path), true);

      const rawRecord = readFileSync(saved.path, 'utf-8');
      assert.doesNotMatch(rawRecord, /do-not-store/);

      const runs = listRuns();
      assert.equal(runs.length, 1);
      assert.equal(runs[0]?.agent, 'runs-agent');
      assert.equal(runs[0]?.rollbackStatus, 'not-needed');
      assert.equal(runs[0]?.recoveryRequired, false);

      const latest = readRun('latest');
      assert.equal(latest?.id, saved.id);
      assert.equal(latest?.files[0]?.path, 'src/run.ts');
      assert.equal(latest?.rollbackStatus, 'not-needed');
      assert.equal(latest?.recoveryRequired, false);
    } finally {
      process.chdir(previousCwd);
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
