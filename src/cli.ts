#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────
//  mythos-router :: cli.ts
//  Main CLI entry point — Commander.js program
// ─────────────────────────────────────────────────────────────

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Command } from 'commander';
import { chatCommand, runCommand } from './commands/chat.js';

// ── Suppress Node.js experimental warnings (SQLite) ─────────
// These leak into terminal output and break polished CLI feel.
const originalEmit = process.emit.bind(process);
// @ts-ignore — intentional override to filter warnings
process.emit = function (event: string, ...args: unknown[]) {
  if (event === 'warning' && (args[0] as { name?: string })?.name === 'ExperimentalWarning') {
    return false;
  }
  return originalEmit(event, ...args);
};
import { verifyCommand } from './commands/verify.js';
import { dreamCommand } from './commands/dream.js';
import { statsCommand } from './commands/stats.js';
import { providersCommand } from './commands/providers.js';
import { initCommand } from './commands/init.js';
import { receiptsCommand } from './commands/receipts.js';
import { skillsCommand } from './commands/skills.js';
import { learnCommand } from './commands/learn.js';
import { swdCommand } from './commands/swd.js';
import { mcpCommand } from './commands/mcp.js';
import { runsCommand } from './commands/runs.js';
import { policyCommand } from './commands/policy.js';
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
// IMPORTANT: Only use 'exit' and 'uncaughtExceptionMonitor' here.
// - 'exit' fires on every process termination, guaranteed cursor restore.
// - Adding a 'SIGINT' listener suppresses Node's default Ctrl+C exit,
//   which breaks non-chat commands (e.g. providers --watch).
// - 'uncaughtExceptionMonitor' observes crashes without preempting
//   command-level shutdown (chat.ts has its own finalize/save logic).
const restoreCursor = () => {
  if (process.stdout.isTTY) {
    process.stdout.write('\x1b[?25h');
  } else if (process.stderr.isTTY) {
    process.stderr.write('\x1b[?25h');
  }
};
process.on('exit', restoreCursor);
process.on('uncaughtExceptionMonitor', restoreCursor);

program
  .name('mythos')
  .description(
    'Capybara-tier CLI router — Claude Opus 4.8 with Adaptive Thinking, ' +
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
    'Command to run after successful SWD execution (prompts before running if model changed command-affecting files)',
  )
  .option(
    '--max-test-retries <n>',
    'Maximum number of times Claude can attempt to fix failing tests',
    '3',
  )
  .option(
    '--test-timeout <ms>',
    'Timeout in milliseconds for each --test-cmd run (default: 120000)',
  )
  .option(
    '-s, --skill <names...>',
    'Load verified skill packs (e.g., -s repo -s security-review)',
  )
  .option(
    '--provider <id>',
    'Force provider for chat/run: anthropic, openai, or deepseek',
  )
  .option(
    '--no-fallback',
    'Disable provider fallback for this session',
  )
  .option(
    '--resume',
    'Resume the last saved session (history + budget state)',
  )
  .option(
    '--escalate',
    'Verified cost-router: run at --effort, then climb one model tier per correction turn only when SWD verification fails',
  )
  .option(
    '--escalate-to <level>',
    'Ceiling tier for --escalate: high (default), medium, low',
  )
  .action(chatCommand);

// mythos run
program
  .command('run')
  .description('Run one prompt through Mythos and exit after SWD verification')
  .argument('[prompt...]', 'Prompt to run once')
  .option(
    '--file <path>',
    'Read the one-shot prompt from a local file',
  )
  .option(
    '--stdin',
    'Read the one-shot prompt from piped standard input',
  )
  .option(
    '-e, --effort <level>',
    'Thinking effort: high (default), medium, low',
    'high',
  )
  .option(
    '--max-tokens <n>',
    `Max tokens for this run (default: ${DEFAULT_MAX_TOKENS_PER_SESSION.toLocaleString()})`,
    String(DEFAULT_MAX_TOKENS_PER_SESSION),
  )
  .option(
    '--max-turns <n>',
    'Max model turns for this run (default: one prompt plus bounded repair turns)',
  )
  .option(
    '--no-budget',
    'Disable budget limits (expert mode - use at your own risk)',
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
    'Run in a new git branch for sandboxed reasoning',
  )
  .option(
    '-t, --test-cmd <cmd>',
    'Command to run after successful SWD execution (prompts before running if model changed command-affecting files)',
  )
  .option(
    '--max-test-retries <n>',
    'Maximum number of times Claude can attempt to fix failing tests',
    '3',
  )
  .option(
    '--test-timeout <ms>',
    'Timeout in milliseconds for each --test-cmd run (default: 120000)',
  )
  .option(
    '-s, --skill <names...>',
    'Load verified skill packs (e.g., -s repo -s security-review)',
  )
  .option(
    '--provider <id>',
    'Force provider for chat/run: anthropic, openai, or deepseek',
  )
  .option(
    '--no-fallback',
    'Disable provider fallback for this run',
  )
  .option(
    '--escalate',
    'Verified cost-router: run at --effort, then climb one model tier per correction turn only when SWD verification fails',
  )
  .option(
    '--escalate-to <level>',
    'Ceiling tier for --escalate: high (default), medium, low',
  )
  .action((prompt: string[] | undefined, options: Parameters<typeof runCommand>[1]) => runCommand((prompt ?? []).join(' '), options));

// ── mythos swd ───────────────────────────────────────────────
program
  .command('swd')
  .description('Apply or validate external-agent file actions through model-free Strict Write Discipline')
  .argument('[action]', 'apply | validate', 'apply')
  .option('--stdin', 'Read external-agent FILE_ACTION or JSON input from stdin')
  .option('--file <path>', 'Read external-agent FILE_ACTION or JSON input from a file')
  .option('--json', 'Print machine-readable JSON output')
  .option('--dry-run', 'Verify the plan without writing files or receipts')
  .option('--no-rollback', 'Disable rollback on failed verification')
  .option('--no-receipt', 'Do not save a SWD receipt')
  .option('--allow-risky', 'Allow high-impact actions that normally require human confirmation; sensitive files remain blocked')
  .option('--check <cmd...>', 'Run trusted shell command(s) in an isolated copy before applying; apply only if all pass (repeatable)')
  .option('--run-checks', 'Run trusted checks declared in .mythos/policy.json in an isolated copy before applying')
  .option('--no-run-log', 'Do not write a local run history record for this apply')
  .option('--request <text>', 'Receipt request label for external-agent runs')
  .option('--summary <text>', 'Receipt summary override')
  .option('--agent <id>', 'External agent identifier for receipts')
  .option('--model <id>', 'External agent model identifier for receipts')
  .action(swdCommand);

// Local external-agent run history
program
  .command('runs')
  .description('List and inspect local external-agent SWD run outcomes')
  .argument('[action]', 'list | show | latest')
  .argument('[target]', 'run id or latest')
  .option('-n, --limit <n>', 'Number of runs to show when listing', '10')
  .option('--json', 'Print machine-readable JSON')
  .action(runsCommand);

// Project policy suggestions
program
  .command('policy')
  .description('Inspect the repository and suggest SWD policy guardrails without writing files')
  .argument('[action]', 'suggest', 'suggest')
  .option('--json', 'Print machine-readable JSON')
  .action(policyCommand);

// MCP stdio adapter for external agent tools
program
  .command('mcp')
  .description('Run the Mythos MCP stdio server for SWD, receipts, and skills tools')
  .argument('[action]', 'server | config', 'server')
  .argument('[client]', 'generic | claude | cursor')
  .option('--json', 'Print only the MCP config JSON when used with config')
  .option('--command <name>', 'Command the MCP client should run', 'mythos')
  .action(mcpCommand);

// ── mythos verify ────────────────────────────────────────────
program
  .command('verify')
  .description('Verify memory drift locally or run read-only CI checks for PR changes')
  .option(
    '--dry-run',
    'Preview verification without writing to MEMORY.md',
  )
  .option(
    '--ci',
    'Run read-only GitHub CI verification against the current PR/diff',
  )
  .option(
    '--strict',
    'In CI mode, fail on warnings as well as high-severity findings',
  )
  .option(
    '--json',
    'In CI mode, print machine-readable JSON',
  )
  .option(
    '--base <ref>',
    'In CI mode, compare against a specific base ref (default: GitHub base ref or HEAD~1)',
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
  .option('--json', 'Print machine-readable JSON for CI and automation')
  .action(statsCommand);

// ── mythos providers ─────────────────────────────────────────
program
  .command('providers')
  .description('Live dashboard of provider health, EMA scoring, and routing decisions')
  .option('-w, --watch', 'Auto-refresh the dashboard when metrics change')
  .option('--verbose', 'Show full error stacks for recent failures')
  .action(providersCommand);

// SWD receipt inspection and drift verification
program
  .command('receipts')
  .description('List, inspect, verify, and undo SWD trust receipts')
  .argument('[action]', 'list | show | verify | undo | latest')
  .argument('[target]', 'receipt id or latest')
  .option('-n, --limit <n>', 'Number of receipts to show when listing', '10')
  .option('--json', 'Print machine-readable JSON')
  .option('--format <format>', 'Output format for show/latest: json | markdown')
  .option('--markdown', 'Print a PR-ready Markdown receipt summary for show/latest')
  .option('--pr', 'Alias for --markdown')
  .option('--yes', 'Apply the undo (without this flag, undo only previews)')
  .option('--force', 'Undo even if the receipt drifted or its integrity hash fails')
  .action(receiptsCommand);

// Mythos skill pack management
program
  .command('skills')
  .description('List, inspect, create, validate, and suggest Mythos skill packs')
  .argument('[action]', 'list | show | new | check | suggest')
  .argument('[name]', 'skill name or path')
  .option('--global', 'Create or write a user-global skill instead of a project-local skill')
  .option('--force', 'Overwrite an existing skill when used with new or suggest --write')
  .option('--write', 'For suggest: write the proposed skill instead of only printing it')
  .option('--min-occurrences <n>', 'For suggest: minimum recurrences before a failure becomes a rule', '2')
  .option('--limit <n>', 'For suggest: maximum number of recent receipts to analyze', '50')
  .option('--json', 'Print machine-readable JSON')
  .action(skillsCommand);

// Repo skill learning
program
  .command('learn')
  .description('Generate a repo-local skill pack from detected project structure')
  .option('--name <name>', 'Project skill name to create', 'repo')
  .option('--force', 'Overwrite an existing generated skill')
  .option('--dry-run', 'Preview the generated skill without writing files')
  .option('--json', 'Print machine-readable JSON')
  .action(learnCommand);

// ── mythos init ──────────────────────────────────────────────
program
  .command('init')
  .description('Initialize mythos-router in the current project')
  .option('-f, --force', 'Re-scaffold files even if they already exist')
  .option('--check', 'Run environment and project setup checks without writing files')
  .action(initCommand);

// ── Default: show help ───────────────────────────────────────
if (process.argv.length <= 2) {
  console.log(BANNER);
  program.help();
} else {
  program.parseAsync();
}
