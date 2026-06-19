import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeTestOutput,
  getTestFailureHint,
  buildTestFailurePrompt,
  isTestOutputUnchanged,
  detectTestRegression,
  resolveTestTimeoutMs,
  summarizeTestResult,
} from '../src/commands/test-healing.js';

describe('normalizeTestOutput', () => {
  it('strips volatile timing tokens so reruns compare equal', () => {
    const a = normalizeTestOutput('3 passing 120ms\nduration 2.5s');
    const b = normalizeTestOutput('3 passing 9ms\nduration 0.4s');
    assert.equal(a, b);
  });

  it('trims surrounding whitespace', () => {
    assert.equal(normalizeTestOutput('  hello  '), 'hello');
  });
});

describe('getTestFailureHint', () => {
  it('flags runtime errors', () => {
    assert.equal(getTestFailureHint('TypeError: x is not a function'), 'Runtime error detected.');
    assert.equal(getTestFailureHint('ReferenceError: y'), 'Runtime error detected.');
  });

  it('flags TypeScript compilation errors', () => {
    assert.equal(getTestFailureHint('foo.ts(3,1): error TS2304'), 'TypeScript compilation issue detected.');
  });

  it('returns empty string for generic failures', () => {
    assert.equal(getTestFailureHint('AssertionError: expected 1 to equal 2'), '');
  });
});

describe('buildTestFailurePrompt', () => {
  it('embeds command and output and marks output as untrusted', () => {
    const prompt = buildTestFailurePrompt('npm test', 'boom', 'Runtime error detected.');
    assert.ok(prompt.includes('npm test'));
    assert.ok(prompt.includes('boom'));
    assert.ok(prompt.includes('untrusted'));
    assert.ok(prompt.includes('Hint: Runtime error detected.'));
  });

  it('omits the hint line when no hint is provided', () => {
    const prompt = buildTestFailurePrompt('npm test', 'boom', '');
    assert.ok(!prompt.includes('Hint:'));
  });
});

describe('isTestOutputUnchanged', () => {
  it('is never unchanged on the first attempt', () => {
    assert.equal(isTestOutputUnchanged(1, 'same', 'same'), false);
  });

  it('treats timing-only differences as unchanged', () => {
    assert.equal(isTestOutputUnchanged(2, 'fail 10ms', 'fail 99ms'), true);
  });

  it('detects real changes', () => {
    assert.equal(isTestOutputUnchanged(2, 'fail A', 'fail B'), false);
  });
});

describe('detectTestRegression', () => {
  it('never reports a regression on the first attempt', () => {
    assert.equal(detectTestRegression(1, 5, 0), false);
  });

  it('reports a regression when failures increase', () => {
    assert.equal(detectTestRegression(2, 5, 3), true);
  });

  it('does not report when failures hold or drop', () => {
    assert.equal(detectTestRegression(2, 3, 3), false);
    assert.equal(detectTestRegression(2, 2, 3), false);
  });
});

describe('resolveTestTimeoutMs', () => {
  it('defaults to 120s', () => {
    assert.equal(resolveTestTimeoutMs(undefined), 120_000);
  });

  it('honors a valid positive override', () => {
    assert.equal(resolveTestTimeoutMs('5000'), 5000);
  });

  it('falls back on non-positive or junk values', () => {
    assert.equal(resolveTestTimeoutMs('0'), 120_000);
    assert.equal(resolveTestTimeoutMs('-3'), 120_000);
    assert.equal(resolveTestTimeoutMs('abc'), 120_000);
  });
});

describe('summarizeTestResult', () => {
  it('captures command/passed/attempts/status', () => {
    const r = summarizeTestResult('npm test', true, 2, 'passed', 'ok');
    assert.equal(r.command, 'npm test');
    assert.equal(r.passed, true);
    assert.equal(r.attempts, 2);
    assert.equal(r.status, 'passed');
    assert.ok(r.outputTail && r.outputTail.length > 0);
  });

  it('omits outputTail when output is empty', () => {
    const r = summarizeTestResult('npm test', false, 0, 'budget-exhausted', '   ');
    assert.equal(r.outputTail, undefined);
  });
});
