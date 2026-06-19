import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { type ChatUI, TerminalUI, warnIfMalformedFileActionOutput } from '../src/commands/chat-ui.js';
import type { Spinner } from '../src/utils.js';
import { captureRun, stripAnsi } from './support.js';

function recordingUI(): { ui: ChatUI; warnings: string[] } {
  const warnings: string[] = [];
  const noop = () => {};
  const ui: ChatUI = {
    startLoading: noop,
    updateLoading: noop,
    stopLoading: noop,
    write: noop,
    log: noop,
    warn: (m) => warnings.push(m),
    error: noop,
    success: noop,
    divider: noop,
  };
  return { ui, warnings };
}

describe('warnIfMalformedFileActionOutput', () => {
  it('warns when a FILE_ACTION marker is present but nothing parsed', () => {
    const { ui, warnings } = recordingUI();
    warnIfMalformedFileActionOutput('blah [FILE_ACTION: src/x.ts] blah', 0, ui);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /no valid actions/);
  });

  it('stays silent when actions were parsed', () => {
    const { ui, warnings } = recordingUI();
    warnIfMalformedFileActionOutput('[FILE_ACTION: src/x.ts]', 1, ui);
    assert.equal(warnings.length, 0);
  });

  it('stays silent when there is no marker at all', () => {
    const { ui, warnings } = recordingUI();
    warnIfMalformedFileActionOutput('just prose, no actions', 0, ui);
    assert.equal(warnings.length, 0);
  });
});

describe('TerminalUI', () => {
  it('forwards loading calls to the spinner', () => {
    const calls: string[] = [];
    const fakeSpinner = {
      start: (m: string) => calls.push(`start:${m}`),
      update: (m: string) => calls.push(`update:${m}`),
      stop: (m?: string) => calls.push(`stop:${m ?? ''}`),
    } as unknown as Spinner;

    const ui = new TerminalUI(fakeSpinner);
    ui.startLoading('a');
    ui.updateLoading('b');
    ui.stopLoading('c');
    assert.deepEqual(calls, ['start:a', 'update:b', 'stop:c']);
  });

  it('routes log/warn/success through the console', async () => {
    const fakeSpinner = { start() {}, update() {}, stop() {} } as unknown as Spinner;
    const ui = new TerminalUI(fakeSpinner);
    const { output } = await captureRun(() => {
      ui.log('hello-log');
      ui.warn('hello-warn');
      ui.success('hello-success');
    });
    const text = stripAnsi(output);
    assert.ok(text.includes('hello-log'));
    assert.ok(text.includes('hello-warn'));
    assert.ok(text.includes('hello-success'));
  });
});
