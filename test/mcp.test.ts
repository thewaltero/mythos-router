import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handleMCPMessage } from '../src/mcp.js';
import { createMCPServerConfig, renderMCPConfig } from '../src/mcp-config.js';
import { createSWDReceipt, saveSWDReceipt } from '../src/receipts.js';

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

describe('MCP adapter', () => {
  it('renders paste-ready MCP client config', () => {
    const config = createMCPServerConfig();
    assert.equal(config.mcpServers['mythos-router'].command, 'mythos');
    assert.deepEqual(config.mcpServers['mythos-router'].args, ['mcp']);

    const rendered = renderMCPConfig('cursor');
    assert.match(rendered, /Mythos MCP config \(Cursor\)/);
    assert.match(rendered, /"mythos-router"/);
    assert.match(rendered, /"args": \[\s+"mcp"\s+\]/);
  });

  it('initializes with tool capability metadata', async () => {
    const response = await handleMCPMessage({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'test-client', version: '0.0.0' },
      },
    });

    assert.equal(response?.jsonrpc, '2.0');
    assert.equal(response?.id, 1);
    assert.ok(response && 'result' in response);
    assert.equal(response.result.protocolVersion, '2025-06-18');
    assert.deepEqual(response.result.capabilities, { tools: { listChanged: false } });
  });

  it('lists SWD, receipt, and skill tools with safety annotations', async () => {
    const response = await handleMCPMessage({
      jsonrpc: '2.0',
      id: 'tools',
      method: 'tools/list',
    });

    assert.ok(response && 'result' in response);
    const tools = response.result.tools as Array<{ name: string; annotations?: Record<string, unknown> }>;
    const names = tools.map((tool) => tool.name);

    assert.ok(names.includes('swd_validate'));
    assert.ok(names.includes('swd_dry_run'));
    assert.ok(names.includes('swd_apply'));
    assert.ok(names.includes('receipts_list'));
    assert.ok(names.includes('receipts_show'));
    assert.ok(names.includes('receipts_verify'));
    assert.ok(names.includes('receipts_undo'));
    assert.ok(names.includes('skills_list'));
    assert.ok(names.includes('skills_check'));
    assert.ok(names.includes('skills_suggest'));
    assert.ok(names.includes('doctor'));
    assert.ok(names.includes('policy_suggest'));
    assert.ok(names.includes('runs_list'));
    assert.ok(names.includes('runs_show'));
    assert.equal(tools.find((tool) => tool.name === 'swd_dry_run')?.annotations?.readOnlyHint, true);
    assert.equal(tools.find((tool) => tool.name === 'swd_validate')?.annotations?.readOnlyHint, true);
    assert.equal(tools.find((tool) => tool.name === 'swd_apply')?.annotations?.destructiveHint, true);
    assert.equal(tools.find((tool) => tool.name === 'receipts_undo')?.annotations?.destructiveHint, true);
    assert.equal(tools.find((tool) => tool.name === 'policy_suggest')?.annotations?.readOnlyHint, true);
    assert.equal(tools.find((tool) => tool.name === 'runs_list')?.annotations?.readOnlyHint, true);
  });

  it('validates external actions through MCP without writing files', async () => {
    await withTempProject('mythos-mcp-validate-', async () => {
      const response = await handleMCPMessage({
        jsonrpc: '2.0',
        id: 20,
        method: 'tools/call',
        params: {
          name: 'swd_validate',
          arguments: {
            contract: {
              allowedPaths: ['src/**'],
              expectedOutputs: ['src/mcp-validated.ts'],
            },
            actions: [
              {
                path: 'src/mcp-validated.ts',
                operation: 'CREATE',
                description: 'Validate MCP action',
                content: 'export const ok = true;\n',
              },
            ],
          },
        },
      });

      assert.ok(response && 'result' in response);
      assert.equal(response.result.isError, false);
      const structured = response.result.structuredContent as { ok: boolean; contract?: { ok: boolean } };
      assert.equal(structured.ok, true);
      assert.equal(structured.contract?.ok, true);
      assert.equal(existsSync(join('src', 'mcp-validated.ts')), false);
    });
  });

  it('dry-runs external actions without writing files', async () => {
    await withTempProject('mythos-mcp-dryrun-', async () => {
      const response = await handleMCPMessage({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'swd_dry_run',
          arguments: {
            actions: [
              {
                path: 'planned.txt',
                operation: 'CREATE',
                intent: 'MUTATE',
                description: 'Plan a file write',
                content: 'planned only',
              },
            ],
            agentId: 'mcp-test',
            modelId: 'manual',
          },
        },
      });

      assert.ok(response && 'result' in response);
      assert.equal(response.result.isError, false);
      const structured = response.result.structuredContent as { ok: boolean; mode: string };
      assert.equal(structured.ok, true);
      assert.equal(structured.mode, 'dry-run');
      assert.equal(existsSync('planned.txt'), false);
    });
  });

  it('returns tool errors for blocked sensitive paths', async () => {
    await withTempProject('mythos-mcp-blocked-', async () => {
      const response = await handleMCPMessage({
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: {
          name: 'swd_apply',
          arguments: {
            actions: [
              {
                path: '.env',
                operation: 'CREATE',
                description: 'Attempt secret write',
                content: 'SECRET=bad',
              },
            ],
          },
        },
      });

      assert.ok(response && 'result' in response);
      assert.equal(response.result.isError, true);
      const structured = response.result.structuredContent as { ok: boolean; rejected: Array<{ risk: string }> };
      assert.equal(structured.ok, false);
      assert.equal(structured.rejected[0]?.risk, 'block');
      assert.equal(existsSync('.env'), false);
    });
  });

  it('returns PR-ready receipt markdown through receipts_show', async () => {
    await withTempProject('mythos-mcp-receipt-md-', async () => {
      const receipt = createSWDReceipt({
        request: 'external agent failed write',
        summary: 'MODIFY: failed.txt',
        provider: {
          providerId: 'external:mcp-agent',
          modelId: 'manual',
        },
        result: {
          success: false,
          rolledBack: true,
          rollbackErrors: [],
          errors: ['Hash mismatch after write'],
          results: [
            {
              action: {
                path: 'failed.txt',
                operation: 'MODIFY',
                intent: 'MUTATE',
                description: 'Update failed file',
              },
              status: 'drift',
              detail: 'Hash mismatch after MODIFY failed.txt',
            },
          ],
        },
      });
      saveSWDReceipt(receipt);

      const response = await handleMCPMessage({
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: {
          name: 'receipts_show',
          arguments: {
            target: receipt.id,
            format: 'markdown',
          },
        },
      });

      assert.ok(response && 'result' in response);
      assert.equal(response.result.isError, false);
      const structured = response.result.structuredContent as { ok: boolean; markdown: string };
      assert.equal(structured.ok, true);
      assert.match(structured.markdown, /### Mythos SWD Receipt/);
      assert.match(structured.markdown, /\| Status \| failed \(rolled back\) \|/);
      assert.match(structured.markdown, /Hash mismatch after write/);
      const content = response.result.content as Array<{ type: string; text: string }>;
      assert.match(content[0]!.text, new RegExp(`mythos receipts verify ${receipt.id}`));
    });
  });
});

  it('doctor inspects workspace health without repair by default', async () => {
    await withTempProject('mythos-mcp-doctor-', async () => {
      const response = await handleMCPMessage({
        jsonrpc: '2.0',
        id: 50,
        method: 'tools/call',
        params: { name: 'doctor', arguments: {} },
      });

      assert.ok(response && 'result' in response);
      const structured = response.result.structuredContent as {
        ok: boolean;
        report: { tool: string; repairRequested: boolean; checks: unknown[] };
      };
      assert.equal(structured.report.tool, 'mythos-doctor');
      assert.equal(structured.report.repairRequested, false);
      assert.ok(Array.isArray(structured.report.checks));
      assert.ok(structured.report.checks.length > 0);
    });
  });

  it('policy_suggest returns a read-only suggestion payload', async () => {
    await withTempProject('mythos-mcp-policy-', async () => {
      const response = await handleMCPMessage({
        jsonrpc: '2.0',
        id: 51,
        method: 'tools/call',
        params: { name: 'policy_suggest', arguments: {} },
      });

      assert.ok(response && 'result' in response);
      assert.equal(response.result.isError, false);
      const structured = response.result.structuredContent as {
        ok: boolean;
        result: { suggestions: unknown[]; policyPatch: unknown };
      };
      assert.equal(structured.ok, true);
      assert.ok(Array.isArray(structured.result.suggestions));
      assert.ok(structured.result.policyPatch);
    });
  });

  it('runs_list and runs_show handle an empty run ledger', async () => {
    await withTempProject('mythos-mcp-runs-', async () => {
      const listResponse = await handleMCPMessage({
        jsonrpc: '2.0',
        id: 52,
        method: 'tools/call',
        params: { name: 'runs_list', arguments: { limit: 5 } },
      });
      assert.ok(listResponse && 'result' in listResponse);
      assert.equal(listResponse.result.isError, false);
      const listStructured = listResponse.result.structuredContent as { ok: boolean; runs: unknown[] };
      assert.equal(listStructured.ok, true);
      assert.deepEqual(listStructured.runs, []);

      const showResponse = await handleMCPMessage({
        jsonrpc: '2.0',
        id: 53,
        method: 'tools/call',
        params: { name: 'runs_show', arguments: { target: 'latest' } },
      });
      assert.ok(showResponse && 'result' in showResponse);
      assert.equal(showResponse.result.isError, true);
      const showStructured = showResponse.result.structuredContent as { ok: boolean; error: string };
      assert.equal(showStructured.ok, false);
      assert.match(showStructured.error, /Run not found/i);
    });
  });

  it('receipts_undo previews by default and does not apply', async () => {
    await withTempProject('mythos-mcp-undo-', async () => {
      const receipt = createSWDReceipt({
        request: 'create then undo preview',
        summary: 'CREATE: preview.txt',
        provider: { providerId: 'external:mcp-agent', modelId: 'manual' },
        result: {
          success: true,
          rolledBack: false,
          rollbackErrors: [],
          errors: [],
          results: [
            {
              action: {
                path: 'preview.txt',
                operation: 'CREATE',
                intent: 'MUTATE',
                description: 'Create preview file',
              },
              status: 'verified',
              detail: 'Verified: CREATE preview.txt',
              after: {
                path: 'preview.txt',
                exists: true,
                size: 4,
                mtime: Date.now(),
                hash: 'a'.repeat(64),
              },
            },
          ],
        },
      });
      saveSWDReceipt(receipt);

      const response = await handleMCPMessage({
        jsonrpc: '2.0',
        id: 54,
        method: 'tools/call',
        params: {
          name: 'receipts_undo',
          arguments: { target: receipt.id },
        },
      });

      assert.ok(response && 'result' in response);
      const structured = response.result.structuredContent as {
        ok: boolean;
        applied: boolean;
        plan: { receiptId: string; items: unknown[] };
      };
      assert.equal(structured.applied, false);
      assert.equal(structured.plan.receiptId, receipt.id);
      assert.ok(Array.isArray(structured.plan.items));
    });
  });

  it('skills_suggest returns analysis without writing by default', async () => {
    await withTempProject('mythos-mcp-skills-suggest-', async () => {
      const response = await handleMCPMessage({
        jsonrpc: '2.0',
        id: 55,
        method: 'tools/call',
        params: {
          name: 'skills_suggest',
          arguments: { limit: 10, minOccurrences: 2 },
        },
      });

      assert.ok(response && 'result' in response);
      assert.equal(response.result.isError, false);
      const structured = response.result.structuredContent as {
        ok: boolean;
        written: null;
        result: { rules: unknown[] };
      };
      assert.equal(structured.ok, true);
      assert.equal(structured.written, null);
      assert.ok(Array.isArray(structured.result.rules));
    });
  });

  it('streams notifications/progress when tools/call includes progressToken', async () => {
    await withTempProject('mythos-mcp-progress-', async () => {
      const notifications: Array<{ method: string; params?: Record<string, unknown> }> = [];

      const response = await handleMCPMessage(
        {
          jsonrpc: '2.0',
          id: 90,
          method: 'tools/call',
          params: {
            name: 'swd_dry_run',
            arguments: {
              actions: [
                {
                  path: 'streamed.txt',
                  operation: 'CREATE',
                  intent: 'MUTATE',
                  description: 'Progress streaming dry-run',
                  content: 'stream me\n',
                },
              ],
            },
            _meta: { progressToken: 'tok-stream-1' },
          },
        },
        undefined,
        {
          onNotification: (notification) => {
            notifications.push({
              method: notification.method,
              params: notification.params,
            });
          },
        },
      );

      assert.ok(response && 'result' in response);
      assert.equal(response.result.isError, false);
      assert.ok(notifications.length >= 2, `expected progress notifications, got ${notifications.length}`);
      for (const note of notifications) {
        assert.equal(note.method, 'notifications/progress');
        assert.equal(note.params?.progressToken, 'tok-stream-1');
        assert.equal(typeof note.params?.progress, 'number');
        assert.equal(note.params?.total, 100);
      }
      const last = notifications[notifications.length - 1]!;
      assert.equal(last.params?.progress, 100);
    });
  });

  it('does not emit progress notifications without a progressToken', async () => {
    await withTempProject('mythos-mcp-no-progress-', async () => {
      const notifications: unknown[] = [];
      const response = await handleMCPMessage(
        {
          jsonrpc: '2.0',
          id: 91,
          method: 'tools/call',
          params: {
            name: 'skills_list',
            arguments: {},
          },
        },
        undefined,
        {
          onNotification: (notification) => {
            notifications.push(notification);
          },
        },
      );

      assert.ok(response && 'result' in response);
      assert.equal(response.result.isError, false);
      assert.equal(notifications.length, 0);
    });
  });
