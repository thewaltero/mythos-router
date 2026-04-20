import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  getEffort,
  MODELS,
  CAPYBARA_SYSTEM_PROMPT,
  MAX_CORRECTION_RETRIES,
  DEFAULT_MAX_TOKENS_PER_SESSION,
  DEFAULT_MAX_TURNS,
  BUDGET_WARN_PERCENT,
  COST_PER_INPUT_TOKEN,
  COST_PER_OUTPUT_TOKEN,
  DEFAULT_IGNORE_PATTERNS,
  MEMORY_FILE,
  MEMORY_DB_FILE,
  MEMORY_MAX_LINES,
} from '../src/config.js';


describe('getEffort', () => {
  it('returns high by default', () => {
    assert.equal(getEffort(), 'high');
    assert.equal(getEffort(undefined), 'high');
  });

  it('parses "high" and alias "h"', () => {
    assert.equal(getEffort('high'), 'high');
    assert.equal(getEffort('h'), 'high');
  });

  it('parses "medium" and aliases', () => {
    assert.equal(getEffort('medium'), 'medium');
    assert.equal(getEffort('med'), 'medium');
    assert.equal(getEffort('m'), 'medium');
  });

  it('parses "low" and alias "l"', () => {
    assert.equal(getEffort('low'), 'low');
    assert.equal(getEffort('l'), 'low');
  });

  it('defaults to high for invalid input (with warning)', () => {
    assert.equal(getEffort('banana'), 'high');
    assert.equal(getEffort('extreme'), 'high');
    assert.equal(getEffort(''), 'high');
  });
});


describe('Config Constants', () => {
  it('MODELS maps effort levels to model identifiers', () => {
    assert.ok(MODELS['high']);
    assert.ok(MODELS['medium']);
    assert.ok(MODELS['low']);
    assert.ok(MODELS['high']!.includes('opus'));
    assert.ok(MODELS['medium']!.includes('sonnet'));
    assert.ok(MODELS['low']!.includes('haiku'));
  });

  it('system prompt contains core directives', () => {
    assert.ok(CAPYBARA_SYSTEM_PROMPT.includes('Strict Write Discipline'));
    assert.ok(CAPYBARA_SYSTEM_PROMPT.includes('FILE_ACTION'));
    assert.ok(CAPYBARA_SYSTEM_PROMPT.includes('OPERATION'));
    assert.ok(CAPYBARA_SYSTEM_PROMPT.includes('Correction Turn'));
  });

  it('budget defaults are sensible', () => {
    assert.ok(DEFAULT_MAX_TOKENS_PER_SESSION >= 100_000);
    assert.ok(DEFAULT_MAX_TURNS >= 10);
    assert.ok(BUDGET_WARN_PERCENT > 50 && BUDGET_WARN_PERCENT < 100);
  });

  it('pricing constants are positive numbers', () => {
    assert.ok(COST_PER_INPUT_TOKEN > 0);
    assert.ok(COST_PER_OUTPUT_TOKEN > 0);
    assert.ok(COST_PER_OUTPUT_TOKEN > COST_PER_INPUT_TOKEN); // output is always more expensive
  });

  it('correction retries is a small positive integer', () => {
    assert.ok(MAX_CORRECTION_RETRIES >= 1 && MAX_CORRECTION_RETRIES <= 5);
  });

  it('ignore patterns include standard directories', () => {
    assert.ok(DEFAULT_IGNORE_PATTERNS.includes('node_modules'));
    assert.ok(DEFAULT_IGNORE_PATTERNS.includes('.git'));
    assert.ok(DEFAULT_IGNORE_PATTERNS.includes('dist'));
  });

  it('memory config is set', () => {
    assert.equal(MEMORY_FILE, 'MEMORY.md');
    assert.equal(MEMORY_DB_FILE, 'memory.db');
    assert.ok(MEMORY_MAX_LINES > 0);
  });
});
