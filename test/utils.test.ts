import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { beforeEach, afterEach } from 'node:test';
import {
  c,
  timestamp,
  hr,
  heading,
  progressBar,
  dryRunBadge,
  verboseBadge,
  BANNER,
  Spinner,
} from '../src/utils.js';


describe('ANSI Color Constants', () => {
  it('reset code is valid', () => {
    assert.equal(c.reset, '\x1b[0m');
  });

  it('all color codes start with ANSI escape', () => {
    for (const [key, value] of Object.entries(c)) {
      assert.ok(
        value.startsWith('\x1b['),
        `c.${key} should start with ANSI escape, got: ${JSON.stringify(value)}`,
      );
    }
  });

  it('has essential foreground colors', () => {
    assert.ok(c.red);
    assert.ok(c.green);
    assert.ok(c.yellow);
    assert.ok(c.cyan);
    assert.ok(c.blue);
    assert.ok(c.magenta);
  });

  it('has bold and dim modifiers', () => {
    assert.ok(c.bold);
    assert.ok(c.dim);
  });
});


describe('timestamp', () => {
  it('returns a string in YYYY-MM-DD HH:MM:SS format', () => {
    const ts = timestamp();
    assert.match(ts, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });

  it('returns 19 characters', () => {
    assert.equal(timestamp().length, 19);
  });
});


describe('hr', () => {
  it('returns a horizontal rule with default character and length', () => {
    const line = hr();
    assert.ok(line.includes('─'));
    assert.ok(line.includes('─'.repeat(60)));
  });

  it('accepts custom character and length', () => {
    const line = hr('=', 20);
    assert.ok(line.includes('='.repeat(20)));
  });
});


describe('heading', () => {
  it('includes the text and a horizontal rule', () => {
    const h = heading('Test Heading');
    assert.ok(h.includes('Test Heading'));
    assert.ok(h.includes('─'));
  });
});


describe('progressBar', () => {
  it('returns empty bar at 0%', () => {
    const bar = progressBar(0, 10);
    assert.equal(bar, '[░░░░░░░░░░]');
  });

  it('returns full bar at 100%', () => {
    const bar = progressBar(100, 10);
    assert.equal(bar, '[██████████]');
  });

  it('returns half bar at 50%', () => {
    const bar = progressBar(50, 10);
    assert.equal(bar, '[█████░░░░░]');
  });

  it('clamps negative values to 0%', () => {
    const bar = progressBar(-10, 10);
    assert.equal(bar, '[░░░░░░░░░░]');
  });

  it('clamps values over 100% to 100%', () => {
    const bar = progressBar(200, 10);
    assert.equal(bar, '[██████████]');
  });

  it('uses default width of 20', () => {
    const bar = progressBar(50);
    const inner = bar.slice(1, -1);
    assert.equal(inner.length, 20);
  });
});


describe('Badges', () => {
  it('dryRunBadge contains DRY-RUN text', () => {
    const badge = dryRunBadge();
    assert.ok(badge.includes('DRY-RUN'));
  });

  it('verboseBadge contains VERBOSE text', () => {
    const badge = verboseBadge();
    assert.ok(badge.includes('VERBOSE'));
  });
});


describe('BANNER', () => {
  it('contains the MYTHOS ASCII art', () => {
    assert.ok(BANNER.includes('███'));
    assert.ok(BANNER.includes('MYTHOS') || BANNER.includes('█'));
  });

  it('is a non-empty string', () => {
    assert.ok(typeof BANNER === 'string');
    assert.ok(BANNER.length > 100);
  });
});

describe('Spinner', () => {
  let originalStdoutWrite: typeof process.stdout.write;
  let stdoutData: string[] = [];

  beforeEach(() => {
    stdoutData = [];
    originalStdoutWrite = process.stdout.write;
    process.stdout.write = (chunk: string | Uint8Array, encoding?: any, cb?: any) => {
      stdoutData.push(chunk.toString());
      if (typeof encoding === 'function') encoding();
      else if (typeof cb === 'function') cb();
      return true;
    };
  });

  afterEach(() => {
    process.stdout.write = originalStdoutWrite;
  });

  it('starts and stops correctly', () => {
    const spinner = new Spinner();
    spinner.start('Test msg');
    assert.ok(stdoutData.some(d => d.includes('Test msg')));
    
    spinner.stop('Done');
    assert.ok(stdoutData.some(d => d.includes('Done')));
  });

  it('updates the message keeping the spinner active', () => {
    const spinner = new Spinner();
    spinner.start('Start msg');
    spinner.update('Updated msg');
    
    // update should force a render immediately
    assert.ok(stdoutData.some(d => d.includes('Updated msg')));
    spinner.stop();
  });
});
