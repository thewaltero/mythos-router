// ─────────────────────────────────────────────────────────────
//  mythos-router :: commands/run-input.ts
//  Input plumbing for one-shot `mythos run`.
//
//  Pure-ish helpers that resolve the prompt source, normalize options, and
//  format small values. Kept out of chat.ts so the validation rules (exactly
//  one prompt source, non-empty content, sensible defaults) are unit-testable
//  in isolation from the model/turn loop.
// ─────────────────────────────────────────────────────────────

import { readFileSync } from 'node:fs';
import { resolveSafePath } from '../swd.js';
import { MAX_CORRECTION_RETRIES } from '../config.js';
import type { ChatOptions, RunOptions } from './chat-types.js';

/**
 * Resolve the single prompt source for a run: inline argument, `--file`, or
 * `--stdin`. Exactly one must be provided; zero or multiple is a usage error.
 */
export async function resolveRunPrompt(prompt: string, options: RunOptions): Promise<string> {
  const inlinePrompt = prompt.trim();
  const hasInlinePrompt = inlinePrompt.length > 0;
  const hasFilePrompt = typeof options.file === 'string' && options.file.trim().length > 0;
  const hasStdinPrompt = options.stdin === true;
  const sourceCount = [hasInlinePrompt, hasFilePrompt, hasStdinPrompt].filter(Boolean).length;

  if (sourceCount === 0) {
    throw new Error('Provide a prompt, --file <path>, or --stdin.');
  }

  if (sourceCount > 1) {
    throw new Error('Use only one prompt source: inline prompt, --file, or --stdin.');
  }

  if (hasFilePrompt) {
    const filePath = options.file!.trim();
    try {
      return normalizePromptContent(readFileSync(resolveSafePath(filePath), 'utf-8'), `prompt file ${filePath}`);
    } catch (err: any) {
      throw new Error(`Unable to read prompt file ${filePath}: ${err.message}`);
    }
  }

  if (hasStdinPrompt) {
    if (process.stdin.isTTY) {
      throw new Error('--stdin requires piped input.');
    }
    return normalizePromptContent(await readStdin(), 'stdin');
  }

  return inlinePrompt;
}

export function normalizePromptContent(content: string, source: string): string {
  const input = content.trim();
  if (!input) {
    throw new Error(`Run prompt from ${source} cannot be empty.`);
  }
  return input;
}

export async function readStdin(): Promise<string> {
  process.stdin.setEncoding('utf-8');
  let input = '';
  for await (const chunk of process.stdin) {
    input += String(chunk);
  }
  return input;
}

/**
 * Derive the effective ChatOptions for a run. The turn budget defaults to one
 * initial turn plus the SWD correction retries, plus the test-retry budget
 * when a `--test-cmd` healing loop is in play.
 */
export function normalizeRunOptions(options: RunOptions): ChatOptions {
  const maxTestRetries = parsePositiveInt(options.maxTestRetries, 3);
  const defaultMaxTurns = 1 + MAX_CORRECTION_RETRIES + (options.testCmd ? maxTestRetries : 0);

  return {
    ...options,
    mode: 'run',
    resume: false,
    maxTurns: options.maxTurns ?? String(defaultMaxTurns),
    maxTestRetries: String(maxTestRetries),
  };
}

export function parsePositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function formatElapsedMs(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const secs = seconds % 60;
  if (minutes < 60) return `${minutes}m ${secs}s`;
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return `${hours}h ${mins}m`;
}
