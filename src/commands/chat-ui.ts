// ─────────────────────────────────────────────────────────────
//  mythos-router :: commands/chat-ui.ts
//  Render layer for the chat/run loop.
//
//  ChatSession talks to the terminal only through the ChatUI interface, so
//  the orchestration logic never touches stdout directly and can be driven
//  by a fake UI in tests. TerminalUI is the production implementation.
// ─────────────────────────────────────────────────────────────

import { Spinner, hr, warn as logWarn, error as logError, success as logSuccess } from '../utils.js';

export interface ChatUI {
  startLoading(msg: string): void;
  updateLoading(msg: string): void;
  stopLoading(msg?: string): void;
  write(text: string): void;   // Raw streaming output (no newline)
  log(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
  success(msg: string): void;
  divider(): void;
}

export class TerminalUI implements ChatUI {
  private spinner: Spinner;

  constructor(spinner: Spinner) {
    this.spinner = spinner;
  }

  startLoading(msg: string) { this.spinner.start(msg); }
  updateLoading(msg: string) { this.spinner.update(msg); }
  stopLoading(msg?: string) { this.spinner.stop(msg); }
  write(text: string) { process.stdout.write(text); }
  log(msg: string) { console.log(msg); }
  warn(msg: string) { logWarn(msg); }
  error(msg: string) { logError(msg); }
  success(msg: string) { logSuccess(msg); }
  divider() { console.log(hr()); }
}

/**
 * Surface a warning when the model clearly *tried* to emit file actions
 * (the `[FILE_ACTION:` marker is present) but the parser recovered none —
 * a strong signal of malformed protocol output worth telling the user about.
 */
export function warnIfMalformedFileActionOutput(output: string, parsedActionCount: number, ui: ChatUI): void {
  if (parsedActionCount === 0 && output.includes('[FILE_ACTION:')) {
    ui.warn('Model attempted FILE_ACTION output, but no valid actions were parsed.');
  }
}
