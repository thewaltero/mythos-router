import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  EFFORT_LADDER,
  DEFAULT_ESCALATION_CEILING,
  effortRank,
  nextEffort,
  effortForCorrection,
  isAtCeiling,
  parseEscalationConfig,
} from '../src/escalation.js';

describe('escalation: ladder and ranking', () => {
  it('orders tiers cheapest to most capable', () => {
    assert.deepEqual([...EFFORT_LADDER], ['low', 'medium', 'high']);
    assert.equal(DEFAULT_ESCALATION_CEILING, 'high');
  });

  it('ranks known tiers by ladder position', () => {
    assert.equal(effortRank('low'), 0);
    assert.equal(effortRank('medium'), 1);
    assert.equal(effortRank('high'), 2);
  });

  it('fails safe by treating an unknown tier as the top rung', () => {
    // Unknown effort should never invite escalation to a more expensive model.
    assert.equal(effortRank('bogus' as any), EFFORT_LADDER.length - 1);
  });
});

describe('escalation: nextEffort', () => {
  it('climbs exactly one rung below the ceiling', () => {
    assert.equal(nextEffort('low'), 'medium');
    assert.equal(nextEffort('medium'), 'high');
  });

  it('returns null at or above the ceiling', () => {
    assert.equal(nextEffort('high'), null);
    assert.equal(nextEffort('medium', 'medium'), null);
    assert.equal(nextEffort('high', 'low'), null);
  });
});

describe('escalation: effortForCorrection', () => {
  const enabled = { enabled: true, ceiling: 'high' as const };

  it('is a no-op when disabled', () => {
    const disabled = { enabled: false, ceiling: 'high' as const };
    assert.equal(effortForCorrection('low', 1, disabled), 'low');
    assert.equal(effortForCorrection('low', 5, disabled), 'low');
  });

  it('climbs one tier per attempt from a cheap base', () => {
    assert.equal(effortForCorrection('low', 1, enabled), 'medium');
    assert.equal(effortForCorrection('low', 2, enabled), 'high');
  });

  it('clamps to the ceiling and never overshoots', () => {
    assert.equal(effortForCorrection('low', 3, enabled), 'high');
    assert.equal(effortForCorrection('low', 99, enabled), 'high');
  });

  it('respects a lowered ceiling', () => {
    const capped = { enabled: true, ceiling: 'medium' as const };
    assert.equal(effortForCorrection('low', 1, capped), 'medium');
    assert.equal(effortForCorrection('low', 2, capped), 'medium');
  });

  it('never demotes below the base even if the ceiling is misconfigured below it', () => {
    const badCeiling = { enabled: true, ceiling: 'low' as const };
    assert.equal(effortForCorrection('high', 1, badCeiling), 'high');
    assert.equal(effortForCorrection('medium', 1, badCeiling), 'medium');
  });

  it('treats a non-positive attempt as no climb', () => {
    assert.equal(effortForCorrection('low', 0, enabled), 'low');
    assert.equal(effortForCorrection('low', -1, enabled), 'low');
  });

  it('does nothing when the base is already at the ceiling', () => {
    assert.equal(effortForCorrection('high', 1, enabled), 'high');
    assert.equal(effortForCorrection('high', 2, enabled), 'high');
  });
});

describe('escalation: isAtCeiling', () => {
  it('detects when there is no room to climb', () => {
    assert.equal(isAtCeiling('high', { enabled: true, ceiling: 'high' }), true);
    assert.equal(isAtCeiling('low', { enabled: true, ceiling: 'high' }), false);
    assert.equal(isAtCeiling('medium', { enabled: true, ceiling: 'medium' }), true);
  });
});

describe('escalation: parseEscalationConfig', () => {
  it('is disabled by default', () => {
    const config = parseEscalationConfig({});
    assert.equal(config.enabled, false);
    assert.equal(config.ceiling, 'high');
  });

  it('enables only when escalate is explicitly true', () => {
    assert.equal(parseEscalationConfig({ escalate: true }).enabled, true);
    assert.equal(parseEscalationConfig({ escalate: false }).enabled, false);
  });

  it('parses the ceiling leniently like --effort', () => {
    assert.equal(parseEscalationConfig({ escalate: true, escalateTo: 'med' }).ceiling, 'medium');
    assert.equal(parseEscalationConfig({ escalate: true, escalateTo: 'l' }).ceiling, 'low');
    // Unknown values fall back to 'high' (the getEffort default).
    assert.equal(parseEscalationConfig({ escalate: true, escalateTo: 'bogus' }).ceiling, 'high');
  });
});
