import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import {
  normalizePromptContent,
  parsePositiveInt,
  formatElapsedMs,
  normalizeRunOptions,
  resolveRunPrompt,
} from '../src/commands/run-input.js';
import { MAX_CORRECTION_RETRIES } from '../src/config.js';
import { withTempCwd } from './support.js';

describe('normalizePromptContent', () => {
  it('trims valid content', () => {
    assert.equal(normalizePromptContent('  hi  ', 'inline'), 'hi');
  });

  it('throws on empty content, naming the source', () => {
    assert.throws(() => normalizePromptContent('   ', 'stdin'), /stdin cannot be empty/);
  });
});

describe('parsePositiveInt', () => {
  it('parses positive integers', () => {
    assert.equal(parsePositiveInt('5', 3), 5);
  });

  it('falls back on undefined, zero, negative, and junk', () => {
    assert.equal(parsePositiveInt(undefined, 3), 3);
    assert.equal(parsePositiveInt('0', 3), 3);
    assert.equal(parsePositiveInt('-2', 3), 3);
    assert.equal(parsePositiveInt('nope', 3), 3);
  });
});

describe('formatElapsedMs', () => {
  it('formats seconds, minutes, and hours', () => {
    assert.equal(formatElapsedMs(5_000), '5s');
    assert.equal(formatElapsedMs(65_000), '1m 5s');
    assert.equal(formatElapsedMs(3_725_000), '1h 2m');
  });
});

describe('normalizeRunOptions', () => {
  it('sets run mode, disables resume, and defaults turns to 1 + corrections', () => {
    const out = normalizeRunOptions({});
    assert.equal(out.mode, 'run');
    assert.equal(out.resume, false);
    assert.equal(out.maxTestRetries, '3');
    assert.equal(out.maxTurns, String(1 + MAX_CORRECTION_RETRIES));
  });

  it('adds the test-retry budget to the turn cap when a test command is set', () => {
    const out = normalizeRunOptions({ testCmd: 'npm test', maxTestRetries: '4' });
    assert.equal(out.maxTurns, String(1 + MAX_CORRECTION_RETRIES + 4));
  });

  it('preserves an explicit maxTurns', () => {
    const out = normalizeRunOptions({ maxTurns: '9' });
    assert.equal(out.maxTurns, '9');
  });
});

describe('resolveRunPrompt', () => {
  it('returns a trimmed inline prompt', async () => {
    assert.equal(await resolveRunPrompt('  build the thing  ', {}), 'build the thing');
  });

  it('rejects when no prompt source is provided', async () => {
    await assert.rejects(() => resolveRunPrompt('', {}), /Provide a prompt/);
  });

  it('rejects when more than one source is provided', async () => {
    await assert.rejects(() => resolveRunPrompt('inline', { stdin: true }), /only one prompt source/);
  });

  it('reads a prompt from a file', async () => {
    await withTempCwd(async () => {
      writeFileSync('prompt.txt', '  do the work  ');
      assert.equal(await resolveRunPrompt('', { file: 'prompt.txt' }), 'do the work');
    });
  });

  it('reports a clear error for a missing file', async () => {
    await withTempCwd(async () => {
      await assert.rejects(() => resolveRunPrompt('', { file: 'nope.txt' }), /Unable to read prompt file/);
    });
  });
});
