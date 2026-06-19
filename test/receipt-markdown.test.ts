import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createSWDReceipt } from '../src/receipts.js';
import { formatReceiptMarkdown } from '../src/receipt-markdown.js';
import type { SWDRunResult, ActionResult } from '../src/swd.js';

function fileResult(overrides: Partial<ActionResult> = {}): ActionResult {
  return {
    action: { path: 'src/index.ts', operation: 'MODIFY', intent: 'MUTATE', description: 'edit' },
    status: 'verified',
    detail: 'Verified: MODIFY src/index.ts',
    ...overrides,
  };
}

function runResult(overrides: Partial<SWDRunResult> = {}): SWDRunResult {
  return {
    success: true,
    rolledBack: false,
    rollbackErrors: [],
    errors: [],
    results: [fileResult()],
    ...overrides,
  };
}

describe('formatReceiptMarkdown', () => {
  it('renders a full receipt with all optional metadata present', () => {
    const receipt = createSWDReceipt({
      request: 'do the thing',
      summary: 'MODIFY: src/index.ts',
      result: runResult(),
      provider: { providerId: 'anthropic', modelId: 'claude-opus-4-8' },
      usage: { inputTokens: 1000, outputTokens: 500 },
      budget: {
        sessionInputTokens: 1000,
        sessionOutputTokens: 500,
        sessionTotalTokens: 1500,
        sessionTurns: 1,
        estimatedCostUSD: 0.1234,
      },
      skills: [{ id: 'repo', name: 'repo', version: '1', source: 'project' }],
      test: { command: 'npm test', passed: true, attempts: 1, status: 'passed' },
      git: { branch: 'mythos/x', commit: 'abcdef1234567890' },
    });

    const md = formatReceiptMarkdown(receipt);
    assert.ok(md.startsWith('### Mythos SWD Receipt'));
    assert.ok(md.includes('anthropic/claude-opus-4-8'));
    assert.ok(md.includes('1,500 tokens'));
    assert.ok(md.includes('~$0.1234'));
    assert.ok(md.includes('repo@1 (project)'));
    assert.ok(md.includes('npm test -> passed'));
    assert.ok(md.includes('abcdef123456')); // 12-char commit prefix
    assert.ok(md.includes('#### Files'));
    assert.ok(md.endsWith('\n'));
  });

  it('renders "unknown"/"none" when optional metadata is absent', () => {
    const receipt = createSWDReceipt({
      request: 'minimal',
      summary: 'minimal run',
      result: runResult(),
    });
    const md = formatReceiptMarkdown(receipt);
    assert.ok(md.includes('| Provider | `unknown` |'));
    assert.ok(md.includes('unknown / unknown')); // usage / cost
    assert.ok(md.includes('| Skills | none |'));
    assert.ok(md.includes('| Test | none |'));
    assert.ok(md.includes('none @ none')); // git branch @ commit
  });

  it('handles a receipt with no file results', () => {
    const receipt = createSWDReceipt({
      request: 'noop',
      summary: 'no files touched',
      result: runResult({ results: [] }),
    });
    const md = formatReceiptMarkdown(receipt);
    assert.ok(md.includes('No file results were recorded.'));
  });

  it('renders SWD errors and rollback errors sections', () => {
    const receipt = createSWDReceipt({
      request: 'failing run',
      summary: 'rolled back',
      result: runResult({
        success: false,
        rolledBack: true,
        errors: ['verification mismatch on src/index.ts'],
        rollbackErrors: ['could not restore src/index.ts'],
      }),
    });
    const md = formatReceiptMarkdown(receipt);
    assert.ok(md.includes('#### SWD Errors'));
    assert.ok(md.includes('verification mismatch on src/index.ts'));
    assert.ok(md.includes('#### Rollback Errors'));
    assert.ok(md.includes('could not restore src/index.ts'));
    assert.ok(md.includes('failed (rolled back)'));
  });

  it('truncates long file detail to keep the table readable', () => {
    const longDetail = 'X'.repeat(400);
    const receipt = createSWDReceipt({
      request: 'long detail',
      summary: 'long',
      result: runResult({ results: [fileResult({ detail: longDetail })] }),
    });
    const md = formatReceiptMarkdown(receipt);
    assert.ok(md.includes('...'), 'expected truncation marker');
    assert.ok(!md.includes('X'.repeat(200)), 'detail should not appear at full length');
  });

  it('escapes markdown table delimiters in paths and summaries', () => {
    const receipt = createSWDReceipt({
      request: 'piped',
      summary: 'a | b table | breaker',
      result: runResult({
        results: [fileResult({ action: { path: 'we`ird|path.ts', operation: 'CREATE', intent: 'MUTATE' } })],
      }),
    });
    const md = formatReceiptMarkdown(receipt);
    assert.ok(md.includes('\\|'), 'pipes must be escaped');
    assert.ok(md.includes('\\`'), 'backticks must be escaped');
  });
});
