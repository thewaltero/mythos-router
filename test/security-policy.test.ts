import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyActionRisk,
  reviewActions,
  touchesCommandSurface,
} from '../src/security-policy.js';
import type { FileAction } from '../src/swd.js';

function action(path: string, operation: FileAction['operation'] = 'MODIFY'): FileAction {
  return {
    path,
    operation,
    intent: 'MUTATE',
    content: 'content',
    description: 'test action',
  };
}

describe('security policy', () => {
  it('auto-approves ordinary source files', () => {
    const verdict = classifyActionRisk(action('src/example.ts'));
    assert.equal(verdict.risk, 'safe');
  });

  it('requires confirmation for command-affecting files', () => {
    const verdict = classifyActionRisk(action('package.json'));
    assert.equal(verdict.risk, 'confirm');
    assert.equal(touchesCommandSurface([action('package.json')]), true);
  });

  it('requires confirmation for deletes', () => {
    const verdict = classifyActionRisk(action('src/old.ts', 'DELETE'));
    assert.equal(verdict.risk, 'confirm');
  });

  it('blocks sensitive files by default', () => {
    const verdict = classifyActionRisk(action('.env'));
    assert.equal(verdict.risk, 'block');
  });

  it('separates safe, confirm, and blocked actions', () => {
    const review = reviewActions([
      action('src/ok.ts'),
      action('package.json'),
      action('.npmrc'),
    ]);

    assert.equal(review.approved.length, 1);
    assert.equal(review.needsConfirmation.length, 1);
    assert.equal(review.blocked.length, 1);
  });
});
