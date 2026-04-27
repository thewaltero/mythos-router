#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────
//  mythos-router :: cli.ts
//  Main CLI entry point — Commander.js program
// ─────────────────────────────────────────────────────────────

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Command } from 'commander';
import { chatCommand } from './commands/chat.js';
import { verifyCommand } from './commands/verify.js';
import { dreamCommand } from './commands/dream.js';
import { statsCommand } from './commands/stats.js';
import { providersCommand } from './commands/providers.js';
import {
  DEFAULT_MAX_TOKENS_PER_SESSION,
  DEFAULT_MAX_TURNS,
} from './config.js';
import { BANNER } from './utils.js';

// ── Read version from package.json (single source of truth) ──
const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(resolve(__dirname, '..', 'package.json'), 'utf-8'));

const program = new Command();

// ── Restore cursor on any exit (spinner crash safety) ────────
const restoreCursor = () => process.stdout.write('\x1b[?25h');
process.on('exit', restoreCursor);
process.on('SIGINT', () => { restoreCursor(); process.exit(0); });
process.on('uncaughtException', (err) => {
  restoreCursor();
  console.error(err);
  process.exit(1);
});

program
  .name('mythos')
  .description(
    'Capybara-tier CLI router — Claude Opus 4.7 with Adaptive Thinking, ' +
    'Strict Write Discipline, and Self-Healing Memory.',
  )
  .version(pkg.version);

// ── mythos chat ──────────────────────────────────────────────
program
  .command('chat')
  .description('Interactive chat with the Capybara thinking protocol')
  .option(
    '-e, --effort <level>',
    'Thinking effort: high (default), medium, low',
    'high',
  )
  .option(
    '--max-tokens <n>',
    `Max tokens per session (default: ${DEFAULT_MAX_TOKENS_PER_SESSION.toLocaleString()})`,
    String(DEFAULT_MAX_TOKENS_PER_SESSION),
  )
  .option(
    '--max-turns <n>',
    `Max turns per session (default: ${DEFAULT_MAX_TURNS})`,
    String(DEFAULT_MAX_TURNS),
  )
  .option(
    '--no-budget',
    'Disable budget limits (expert mode — use at your own risk)',
  )
  .option(
    '--dry-run',
    'Preview all file operations without executing them',
  )
  .option(
    '--verbose',
    'Show detailed SWD traces and memory operations',
  )
  .option(
    '-b, --branch <name>',
    'Run session in a new git branch for sandboxed reasoning',
  )
  .option(
    '-t, --test-cmd <cmd>',
    'Command to run after successful SWD execution (WARNING: assumes a trusted environment and executes arbitrary shell commands)',
  )
  .option(
    '--max-test-retries <n>',
    'Maximum number of times Claude can attempt to fix failing tests',
    '3',
  )
  .option(
    '-s, --skill <names...>',
    'Inject specific expert skills (e.g., -s mcp -s react)',
  )
  .option(
    '--resume',
    'Resume the last saved session (history + budget state)',
  )
  .action(chatCommand);

// ── mythos verify ────────────────────────────────────────────
program
  .command('verify')
  .description('Scan codebase and sync with MEMORY.md for zero drift')
  .option(
    '--dry-run',
    'Preview verification without writing to MEMORY.md',
  )
  .action(verifyCommand);

// ── mythos dream ─────────────────────────────────────────────
program
  .command('dream')
  .description('Summarize and compress agentic memory for context optimization')
  .option('-f, --force', 'Force dream even with few entries', false)
  .option(
    '--dry-run',
    'Preview compression without writing to MEMORY.md',
  )
  .action(dreamCommand);

// ── mythos stats ─────────────────────────────────────────────
program
  .command('stats')
  .description('Show budget analytics and token usage across sessions')
  .option('-d, --days <n>', 'Filter metrics by the last N days')
  .action(statsCommand);

// ── mythos providers ─────────────────────────────────────────
program
  .command('providers')
  .description('Live dashboard of provider health, EMA scoring, and routing decisions')
  .option('-w, --watch', 'Auto-refresh the dashboard when metrics change')
  .option('--verbose', 'Show full error stacks for recent failures')
  .action(providersCommand);

// ── Default: show help ───────────────────────────────────────
if (process.argv.length <= 2) {
  console.log(BANNER);
  program.help();
} else {
  program.parseAsync();
}
