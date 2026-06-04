import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyExternalAgentActions, parseExternalAgentInput } from '../src/commands/swd.js';
import { readReceipt, verifyReceiptIntegrity } from '../src/receipts.js';

async function withTempProject<T>(prefix: string, fn: (dir: string) => Promise<T> | T): Promise<T> {
  const original = process.cwd();
  const dir = mkdtempSync(join(tmpdir(), prefix));
  process.chdir(dir);
  try {
    return await fn(dir);
  } finally {
    process.chdir(original);
    rmSync(dir, { recursive: true, force: true });
  }
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

describe('external-agent SWD API', () => {
  it('parses JSON action arrays as BYOA input', () => {
    const parsed = parseExternalAgentInput(JSON.stringify({
      request: 'fake external agent request',
      agent: { id: 'python-agent', model: 'local-llama' },
      actions: [
        {
          path: 'src/from-agent.txt',
          operation: 'CREATE',
          content: 'hello',
          contentHash: sha256('hello'),
          description: 'Create file from external agent',
        },
      ],
    }));

    assert.equal(parsed.request, 'fake external agent request');
    assert.equal(parsed.agent?.id, 'python-agent');
    assert.equal(parsed.agent?.model, 'local-llama');
    assert.equal(parsed.actions.length, 1);
    assert.equal(parsed.actions[0]!.path, 'src/from-agent.txt');
    assert.equal(parsed.actions[0]!.intent, 'MUTATE');
  });

  it('applies external-agent FILE_ACTION text without any model API key', async () => {
    await withTempProject('mythos-byoa-apply-', async () => {
      delete process.env.ANTHROPIC_API_KEY;
      delete process.env.OPENAI_API_KEY;
      delete process.env.DEEPSEEK_API_KEY;

      const rawInput = `
[FILE_ACTION: verified.txt]
OPERATION: CREATE
INTENT: MUTATE
CONTENT_HASH: ${sha256('verified by swd')}
DESCRIPTION: Create verified file
CONTENT:
verified by swd
[/FILE_ACTION]
`;

      const result = await applyExternalAgentActions({
        rawInput,
        agentId: 'external-test-agent',
        modelId: 'no-llm-key',
      });

      assert.equal(result.ok, true);
      assert.equal(result.approvedCount, 1);
      assert.equal(readFileSync('verified.txt', 'utf-8'), 'verified by swd');
      assert.ok(result.receipt?.id);

      const receipt = readReceipt(result.receipt!.id);
      assert.ok(receipt);
      assert.equal(receipt.provider?.providerId, 'external:external-test-agent');
      assert.equal(receipt.provider?.modelId, 'no-llm-key');
      assert.equal(verifyReceiptIntegrity(receipt), true);
    });
  });

  it('dry-runs external-agent actions without touching disk or saving receipts', async () => {
    await withTempProject('mythos-byoa-dryrun-', async () => {
      const result = await applyExternalAgentActions({
        rawInput: JSON.stringify({
          actions: [{
            path: 'planned.txt',
            operation: 'CREATE',
            content: 'planned only',
            description: 'Plan file creation',
          }],
        }),
        dryRun: true,
      });

      assert.equal(result.ok, true);
      assert.equal(result.mode, 'dry-run');
      assert.equal(existsSync('planned.txt'), false);
      assert.equal(result.receipt, undefined);
      assert.match(result.result.results[0]?.detail ?? '', /Dry-run: planned CREATE/);
    });
  });

  it('fails closed on sensitive files and never writes them', async () => {
    await withTempProject('mythos-byoa-sensitive-', async () => {
      const result = await applyExternalAgentActions({
        rawInput: JSON.stringify({
          actions: [{
            path: '.env',
            operation: 'CREATE',
            content: 'SECRET_TOKEN=should-not-write',
            description: 'Attempt secret write',
          }],
        }),
      });

      assert.equal(result.ok, false);
      assert.equal(result.approvedCount, 0);
      assert.equal(result.rejected[0]?.risk, 'block');
      assert.equal(existsSync('.env'), false);
    });
  });

  it('requires explicit allowRisky for high-impact command-surface files', async () => {
    await withTempProject('mythos-byoa-risky-', async () => {
      const rawInput = JSON.stringify({
        actions: [{
          path: 'package.json',
          operation: 'CREATE',
          content: '{"scripts":{"test":"node test.js"}}\n',
          description: 'Create package script surface',
        }],
      });

      const defaultResult = await applyExternalAgentActions({ rawInput });
      assert.equal(defaultResult.ok, false);
      assert.equal(defaultResult.rejected[0]?.risk, 'confirm');
      assert.equal(existsSync('package.json'), false);

      const allowedResult = await applyExternalAgentActions({ rawInput, allowRisky: true, saveReceipt: false });
      assert.equal(allowedResult.ok, true);
      assert.equal(readFileSync('package.json', 'utf-8'), '{"scripts":{"test":"node test.js"}}\n');
    });
  });

  it('rejects unsafe JSON paths before SWD execution', () => {
    assert.throws(
      () => parseExternalAgentInput(JSON.stringify({
        actions: [{
          path: '../escape.txt',
          operation: 'CREATE',
          content: 'escape',
          description: 'Path traversal attempt',
        }],
      })),
      /Invalid action path/,
    );
  });

  it('rolls back when a declared contentHash (no inlined content) does not match disk', async () => {
    await withTempProject('mythos-byoa-rollback-', async () => {
      writeFileSync('sample.txt', 'before', 'utf-8');
      const result = await applyExternalAgentActions({
        rawInput: JSON.stringify({
          actions: [{
            path: 'sample.txt',
            operation: 'MODIFY',
            intent: 'MUTATE',
            contentHash: sha256('different'),
            description: 'Intentional mismatch',
          }],
        }),
        saveReceipt: false,
      });

      assert.equal(result.ok, false);
      assert.equal(result.result.results[0]?.status, 'drift');
      assert.equal(readFileSync('sample.txt', 'utf-8'), 'before');
    });
  });
});
