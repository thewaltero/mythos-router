import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_CHARS_PER_TOKEN,
  MIN_CHARS_PER_TOKEN,
  MAX_CHARS_PER_TOKEN,
  CALIBRATED_TOKEN_MARGIN,
  UNCALIBRATED_TOKEN_MARGIN,
  COMPRESSION_TARGET_FRACTION,
  MIN_CALIBRATION_SAMPLES,
  estimateTokens,
  clampDensity,
  nextDensity,
  isCalibrated,
  messagesToFitTokenTarget,
  planContextCompression,
  MAX_HISTORY_MESSAGES,
} from '../src/context-guard.js';

describe('estimateTokens', () => {
  it('returns 0 for non-positive or invalid char counts', () => {
    assert.equal(estimateTokens(0, 4, false), 0);
    assert.equal(estimateTokens(-100, 4, false), 0);
    assert.equal(estimateTokens(Number.NaN, 4, false), 0);
  });

  it('applies the larger margin before calibration and the smaller after', () => {
    const chars = 4000;
    const uncalibrated = estimateTokens(chars, 4, false);
    const calibrated = estimateTokens(chars, 4, true);
    assert.equal(uncalibrated, Math.ceil((chars / 4) * UNCALIBRATED_TOKEN_MARGIN));
    assert.equal(calibrated, Math.ceil((chars / 4) * CALIBRATED_TOKEN_MARGIN));
    assert.ok(calibrated < uncalibrated, 'calibrated estimate should be tighter');
  });

  it('estimates MORE tokens for denser content (lower chars/token)', () => {
    const chars = 6000;
    const english = estimateTokens(chars, 4.2, true); // prose
    const code = estimateTokens(chars, 3.0, true);    // dense code/JSON
    assert.ok(code > english, 'dense code should be counted as more tokens');
  });

  it('falls back to the default density when given an invalid density', () => {
    assert.equal(estimateTokens(4000, 0, true), estimateTokens(4000, DEFAULT_CHARS_PER_TOKEN, true));
    assert.equal(estimateTokens(4000, -1, true), estimateTokens(4000, DEFAULT_CHARS_PER_TOKEN, true));
  });
});

describe('clampDensity', () => {
  it('clamps into the plausible tokenizer band', () => {
    assert.equal(clampDensity(1.0), MIN_CHARS_PER_TOKEN);
    assert.equal(clampDensity(100), MAX_CHARS_PER_TOKEN);
    assert.equal(clampDensity(3.5), 3.5);
  });

  it('returns the default for non-finite ratios', () => {
    assert.equal(clampDensity(Number.NaN), DEFAULT_CHARS_PER_TOKEN);
    assert.equal(clampDensity(Number.POSITIVE_INFINITY), DEFAULT_CHARS_PER_TOKEN);
  });
});

describe('nextDensity', () => {
  it('adopts the clamped observed ratio on the first sample', () => {
    // 12000 chars / 4000 tokens = 3.0 chars/token
    assert.equal(nextDensity(DEFAULT_CHARS_PER_TOKEN, 12000, 4000, 0), 3.0);
  });

  it('EMA-smooths subsequent samples toward the observed ratio', () => {
    const current = 4.0;
    const updated = nextDensity(current, 9000, 3000, 1); // observed 3.0
    assert.ok(updated < current && updated > 3.0, 'should move toward 3.0 but not jump fully');
  });

  it('leaves the density unchanged for invalid usage (no reported tokens)', () => {
    assert.equal(nextDensity(4.0, 9000, 0, 2), 4.0);
    assert.equal(nextDensity(4.0, 9000, Number.NaN, 2), 4.0);
    assert.equal(nextDensity(4.0, 0, 3000, 2), 4.0);
  });

  it('clamps a prompt-cache-style under-report instead of trusting it', () => {
    // A cache hit reports very few input tokens for many chars -> huge ratio.
    const updated = nextDensity(DEFAULT_CHARS_PER_TOKEN, 100000, 50, 0);
    assert.equal(updated, MAX_CHARS_PER_TOKEN);
  });
});

describe('isCalibrated', () => {
  it('becomes true only at the sample threshold', () => {
    assert.equal(isCalibrated(MIN_CALIBRATION_SAMPLES - 1), false);
    assert.equal(isCalibrated(MIN_CALIBRATION_SAMPLES), true);
  });
});

describe('messagesToFitTokenTarget', () => {
  it('returns 0 when the kept history already fits the target', () => {
    const lengths = [100, 100, 100];
    assert.equal(messagesToFitTokenTarget(lengths, 100000, 4, true), 0);
  });

  it('drops enough oldest messages to get the tail under the target', () => {
    const lengths = new Array(20).fill(4000); // ~20 large turns
    const effectiveLimit = 20000;
    const drop = messagesToFitTokenTarget(lengths, effectiveLimit, 4, true);
    const target = Math.floor(effectiveLimit * COMPRESSION_TARGET_FRACTION);
    const keptChars = lengths.slice(drop).reduce((a, b) => a + b, 0);
    const keptTokens = estimateTokens(keptChars, 4, true);
    assert.ok(drop > 0, 'should drop at least one message');
    assert.ok(keptTokens <= target, 'kept tail should fit under the target');
  });

  it('drops MORE messages for denser content at the same char volume', () => {
    const lengths = new Array(20).fill(4000);
    const effectiveLimit = 20000;
    const dropProse = messagesToFitTokenTarget(lengths, effectiveLimit, 4.2, true);
    const dropCode = messagesToFitTokenTarget(lengths, effectiveLimit, 3.0, true);
    assert.ok(dropCode >= dropProse, 'denser content should shed at least as many turns');
  });

  it('handles an empty history', () => {
    assert.equal(messagesToFitTokenTarget([], 20000, 4, true), 0);
  });
});

describe('planContextCompression', () => {
  it('returns null when the history is well under both ceilings', () => {
    const lengths = Array(10).fill(200); // tiny, ~50 tokens total
    assert.equal(planContextCompression(lengths, 1000, 4, true), null);
  });

  it('triggers on the message cap and reports it', () => {
    const lengths = Array(MAX_HISTORY_MESSAGES + 5).fill(100);
    const plan = planContextCompression(lengths, 0, 4, true);
    assert.ok(plan, 'expected a compression plan');
    assert.match(plan!.reason, /message cap/);
    assert.ok(plan!.messagesToCompress >= 2);
    // Always keeps at least the most recent turn.
    assert.ok(plan!.messagesToCompress <= lengths.length - 1);
  });

  it('triggers on the token limit for a dense history', () => {
    // ~10 messages of 80k chars each ≈ 200k+ estimated tokens, over the 150k cap,
    // but well under the message cap — so the reason must be the token limit.
    const lengths = Array(10).fill(80_000);
    const plan = planContextCompression(lengths, 0, 4, true);
    assert.ok(plan, 'expected a compression plan');
    assert.match(plan!.reason, /token limit/);
    assert.ok(plan!.messagesToCompress >= 2);
    assert.ok(plan!.messagesToCompress <= lengths.length - 1);
  });

  it('never plans a compression that would drop the only remaining turn', () => {
    const lengths = Array(MAX_HISTORY_MESSAGES + 1).fill(100);
    const plan = planContextCompression(lengths, 0, 4, true);
    assert.ok(plan);
    assert.ok(plan!.messagesToCompress < lengths.length);
  });
});

