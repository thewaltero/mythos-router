// ─────────────────────────────────────────────────────────────
//  mythos-router :: test/ui.test.ts
//  Snapshot/smoke tests for UI rendering functions
//  All functions under test are pure — no I/O, no side effects.
// ─────────────────────────────────────────────────────────────

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  BANNER,
  theme,
  icon,
  stripAnsi,
  modeBadge,
  dryRunBadge,
  verboseBadge,
  branchBadge,
  resumeBadge,
  noBudgetBadge,
  renderBadgeRow,
  renderBox,
  renderSessionCard,
  renderHelpScreen,
  renderExitSummary,
  type SessionCardConfig,
  type ExitSummaryConfig,
  type BadgeRowConfig,
} from '../src/utils.js';


// ── Helpers ──────────────────────────────────────────────────
function plain(str: string): string {
  return stripAnsi(str);
}


// ── Theme & Icon Constants ───────────────────────────────────
describe('Theme constants', () => {
  it('has all semantic color keys', () => {
    assert.ok(theme.success);
    assert.ok(theme.warning);
    assert.ok(theme.error);
    assert.ok(theme.info);
    assert.ok(theme.muted);
    assert.ok(theme.accent);
  });

  it('all theme values are ANSI escape codes', () => {
    for (const [key, value] of Object.entries(theme)) {
      assert.ok(
        value.startsWith('\x1b['),
        `theme.${key} should be an ANSI code, got: ${JSON.stringify(value)}`,
      );
    }
  });
});

describe('Icon constants', () => {
  it('has all semantic icon keys', () => {
    const required = ['success', 'warning', 'error', 'info', 'thinking', 'action', 'rollback', 'budget', 'memory', 'branch'];
    for (const key of required) {
      assert.ok(
        (icon as Record<string, string>)[key],
        `icon.${key} should exist`,
      );
    }
  });

  it('icons are single characters or short strings', () => {
    for (const [key, value] of Object.entries(icon)) {
      assert.ok(value.length <= 3, `icon.${key} should be compact, got length ${value.length}`);
    }
  });
});


// ── stripAnsi ────────────────────────────────────────────────
describe('stripAnsi', () => {
  it('removes ANSI color codes', () => {
    assert.equal(stripAnsi('\x1b[91mhello\x1b[0m'), 'hello');
  });

  it('handles strings with no codes', () => {
    assert.equal(stripAnsi('plain text'), 'plain text');
  });

  it('removes multiple codes', () => {
    assert.equal(stripAnsi('\x1b[1m\x1b[96mtest\x1b[0m'), 'test');
  });
});


// ── Banner ───────────────────────────────────────────────────
describe('BANNER (reworked)', () => {
  it('contains the MYTHOS ASCII art', () => {
    assert.ok(BANNER.includes('███'));
  });

  it('contains the tagline', () => {
    const text = plain(BANNER);
    assert.ok(text.includes('AI code router'), 'Should have tagline');
    assert.ok(text.includes('SWD verification'), 'Should mention SWD');
  });

  it('does NOT contain hardcoded marketing copy', () => {
    const text = plain(BANNER);
    assert.ok(!text.includes('Capybara Tier'), 'Should not have hardcoded tier');
    assert.ok(!text.includes('Zero Slop'), 'Should not have old marketing');
  });
});


// ── Badges ───────────────────────────────────────────────────
describe('modeBadge', () => {
  it('wraps label with ANSI formatting', () => {
    const badge = modeBadge('TEST', '\x1b[42m');
    assert.ok(badge.includes('TEST'));
    assert.ok(badge.includes('\x1b[42m'));
  });
});

describe('Badge variants', () => {
  it('branchBadge includes branch name', () => {
    const badge = branchBadge('mythos/session');
    assert.ok(plain(badge).includes('BRANCH: mythos/session'));
  });

  it('resumeBadge contains RESUME', () => {
    assert.ok(plain(resumeBadge()).includes('RESUME'));
  });

  it('noBudgetBadge contains NO-BUDGET', () => {
    assert.ok(plain(noBudgetBadge()).includes('NO-BUDGET'));
  });
});

describe('renderBadgeRow', () => {
  it('returns empty string when no flags are set', () => {
    assert.equal(renderBadgeRow({}), '');
  });

  it('renders all badges when all flags set', () => {
    const row = renderBadgeRow({
      dryRun: true,
      verbose: true,
      branch: 'test',
      resume: true,
      noBudget: true,
    });
    const text = plain(row);
    assert.ok(text.includes('DRY-RUN'));
    assert.ok(text.includes('BRANCH: test'));
    assert.ok(text.includes('NO-BUDGET'));
    assert.ok(text.includes('RESUME'));
    assert.ok(text.includes('VERBOSE'));
  });

  it('renders single badge correctly', () => {
    const row = renderBadgeRow({ dryRun: true });
    const text = plain(row);
    assert.ok(text.includes('DRY-RUN'));
    assert.ok(!text.includes('VERBOSE'));
  });
});


// ── renderBox ────────────────────────────────────────────────
describe('renderBox', () => {
  it('renders top border with title', () => {
    const box = renderBox('Test', [['Key', 'Value']]);
    const text = plain(box);
    assert.ok(text.includes('┌'));
    assert.ok(text.includes('Test'));
    assert.ok(text.includes('┐'));
  });

  it('renders bottom border', () => {
    const box = renderBox('Test', [['Key', 'Value']]);
    const text = plain(box);
    assert.ok(text.includes('└'));
    assert.ok(text.includes('┘'));
  });

  it('renders row content', () => {
    const box = renderBox('Test', [['Label', 'Content']]);
    const text = plain(box);
    assert.ok(text.includes('Label'));
    assert.ok(text.includes('Content'));
  });

  it('renders multiple rows', () => {
    const box = renderBox('T', [['A', '1'], ['B', '2'], ['C', '3']]);
    const text = plain(box);
    assert.ok(text.includes('A'));
    assert.ok(text.includes('B'));
    assert.ok(text.includes('C'));
  });

  it('handles empty rows', () => {
    const box = renderBox('Empty', [['', '']]);
    const text = plain(box);
    assert.ok(text.includes('Empty'));
    assert.ok(text.includes('│'));
  });

  it('respects custom width', () => {
    const box = renderBox('W', [['K', 'V']], 40);
    const lines = plain(box).split('\n');
    // Bottom border should be exactly 40 chars
    const bottom = lines[lines.length - 1]!;
    assert.equal(bottom.length, 40, `Bottom border should be 40 chars, got ${bottom.length}`);
  });

  it('all lines have the same visual width', () => {
    const box = renderBox('Equal Width', [['Label', 'Value'], ['Longer Label', 'Value']]);
    const lines = plain(box).split('\n');
    const lengths = new Set(lines.map(l => l.length));
    assert.equal(lengths.size, 1, `Expected all lines to have the same width, but got lengths: ${[...lengths].join(', ')}`);
  });
});


// ── renderSessionCard ────────────────────────────────────────
describe('renderSessionCard', () => {
  const defaultConfig: SessionCardConfig = {
    provider: 'Anthropic',
    model: 'claude-opus-4-7',
    dryRun: false,
    budgetEnabled: true,
    branch: 'main',
    memoryEntries: 42,
    memoryActive: true,
    tokensUsed: 15_000,
    maxTokens: 500_000,
    turnsUsed: 3,
    maxTurns: 25,
  };

  it('renders a box with Session title', () => {
    const card = renderSessionCard(defaultConfig);
    const text = plain(card);
    assert.ok(text.includes('Session'));
    assert.ok(text.includes('┌'));
    assert.ok(text.includes('┘'));
  });

  it('shows provider and model', () => {
    const card = renderSessionCard(defaultConfig);
    const text = plain(card);
    assert.ok(text.includes('Anthropic'));
    assert.ok(text.includes('claude-opus-4-7'));
  });

  it('shows Provider label', () => {
    const text = plain(renderSessionCard(defaultConfig));
    assert.ok(text.includes('Provider'));
  });

  it('shows Model label', () => {
    const text = plain(renderSessionCard(defaultConfig));
    assert.ok(text.includes('Model'));
  });

  it('shows branch name', () => {
    const text = plain(renderSessionCard(defaultConfig));
    assert.ok(text.includes('main'));
  });

  it('shows memory entry count', () => {
    const text = plain(renderSessionCard(defaultConfig));
    assert.ok(text.includes('42'));
    assert.ok(text.includes('entries'));
  });

  it('shows memory active status', () => {
    const text = plain(renderSessionCard(defaultConfig));
    assert.ok(text.includes('active'));
  });

  it('shows memory pending when not active', () => {
    const cfg = { ...defaultConfig, memoryActive: false };
    const text = plain(renderSessionCard(cfg));
    assert.ok(text.includes('pending'));
  });

  it('shows budget tokens and turns', () => {
    const text = plain(renderSessionCard(defaultConfig));
    assert.ok(text.includes('15k / 500k'));
    assert.ok(text.includes('3 / 25'));
  });

  it('formats large token budgets with M suffix', () => {
    const cfg = { ...defaultConfig, maxTokens: 1_000_000 };
    const text = plain(renderSessionCard(cfg));
    assert.ok(text.includes('1.0M'));
  });

  it('shows dry-run mode status', () => {
    const onConfig = { ...defaultConfig, dryRun: true };
    const offConfig = { ...defaultConfig, dryRun: false };
    assert.ok(plain(renderSessionCard(onConfig)).includes('dry-run'));
    assert.ok(plain(renderSessionCard(offConfig)).includes('dry-run'));
  });
});


// ── renderHelpScreen ─────────────────────────────────────────
describe('renderHelpScreen', () => {
  it('renders a box with Commands title', () => {
    const help = renderHelpScreen();
    const text = plain(help);
    assert.ok(text.includes('Commands'));
    assert.ok(text.includes('┌'));
    assert.ok(text.includes('┘'));
  });

  it('lists all slash commands', () => {
    const text = plain(renderHelpScreen());
    assert.ok(text.includes('/help'));
    assert.ok(text.includes('/status'));
    assert.ok(text.includes('/budget'));
    assert.ok(text.includes('/memory'));
    assert.ok(text.includes('/clear'));
  });

  it('lists exit commands', () => {
    const text = plain(renderHelpScreen());
    assert.ok(text.includes('exit'));
    assert.ok(text.includes('/q'));
    assert.ok(text.includes('Ctrl+C'));
  });

  it('is a non-empty string', () => {
    const help = renderHelpScreen();
    assert.ok(help.length > 100);
  });
});


// ── renderExitSummary ────────────────────────────────────────
describe('renderExitSummary', () => {
  const defaultConfig: ExitSummaryConfig = {
    duration: '4m 23s',
    turns: 7,
    maxTurns: 25,
    tokens: 42391,
    maxTokens: 500_000,
    cost: 0.8127,
    memoryEntriesAdded: 3,
    saved: true,
  };

  it('renders a box with Session Complete title', () => {
    const summary = renderExitSummary(defaultConfig);
    const text = plain(summary);
    assert.ok(text.includes('Session Complete'));
    assert.ok(text.includes('┌'));
    assert.ok(text.includes('┘'));
  });

  it('shows duration', () => {
    const text = plain(renderExitSummary(defaultConfig));
    assert.ok(text.includes('4m 23s'));
  });

  it('shows turns with max', () => {
    const text = plain(renderExitSummary(defaultConfig));
    assert.ok(text.includes('7'));
    assert.ok(text.includes('25'));
  });

  it('shows formatted token count', () => {
    const text = plain(renderExitSummary(defaultConfig));
    assert.ok(text.includes('42,391') || text.includes('42391'));
  });

  it('shows cost', () => {
    const text = plain(renderExitSummary(defaultConfig));
    assert.ok(text.includes('0.8127'));
  });

  it('shows memory entries added', () => {
    const text = plain(renderExitSummary(defaultConfig));
    assert.ok(text.includes('+3'));
    assert.ok(text.includes('MEMORY.md'));
  });

  it('shows saved status when saved', () => {
    const text = plain(renderExitSummary(defaultConfig));
    assert.ok(text.includes('saved'));
    assert.ok(text.includes(icon.success));
  });

  it('shows not saved status when not saved', () => {
    const cfg = { ...defaultConfig, saved: false };
    const text = plain(renderExitSummary(cfg));
    assert.ok(text.includes('not saved'));
  });

  it('formats large token budgets with M suffix', () => {
    const cfg = { ...defaultConfig, maxTokens: 2_000_000 };
    const text = plain(renderExitSummary(cfg));
    assert.ok(text.includes('2.0M'));
  });
});
