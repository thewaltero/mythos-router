#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────
//  mythos-router :: cli.ts
//  Main CLI entry point — Commander.js program
// ─────────────────────────────────────────────────────────────

import { Command } from 'commander';
import { chatCommand } from './commands/chat.js';
import { verifyCommand } from './commands/verify.js';
import { dreamCommand } from './commands/dream.js';

const program = new Command();

program
  .name('mythos')
  .description(
    'Capybara-tier CLI router — Claude Opus 4.6 with Adaptive Thinking, ' +
      'Strict Write Discipline, and Self-Healing Memory.',
  )
  .version('1.0.0');

// ── mythos chat ──────────────────────────────────────────────
program
  .command('chat')
  .description('Interactive chat with the Capybara thinking protocol')
  .option(
    '-e, --effort <level>',
    'Thinking effort: high (default), medium, low',
    'high',
  )
  .action(async (options) => {
    await chatCommand(options);
  });

// ── mythos verify ────────────────────────────────────────────
program
  .command('verify')
  .description('Scan codebase and sync with MEMORY.md for zero drift')
  .action(async () => {
    await verifyCommand();
  });

// ── mythos dream ─────────────────────────────────────────────
program
  .command('dream')
  .description('Summarize and compress agentic memory for context optimization')
  .option('-f, --force', 'Force dream even with few entries', false)
  .action(async (options) => {
    await dreamCommand(options);
  });

// ── Default: show help ───────────────────────────────────────
if (process.argv.length <= 2) {
  // Import banner and show it before help
  import('./utils.js').then(({ BANNER }) => {
    console.log(BANNER);
    program.help();
  });
} else {
  program.parse();
}
