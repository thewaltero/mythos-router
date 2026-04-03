// ─────────────────────────────────────────────────────────────
//  mythos-router :: commands/chat.ts
//  Interactive REPL with Capybara thinking protocol
//  + Budget Limiter + Dry-Run + Verbose modes
// ─────────────────────────────────────────────────────────────

import * as readline from 'node:readline';
import { resolve } from 'node:path';
import { readdirSync, statSync } from 'node:fs';
import {
  streamMessage,
  formatTokenUsage,
  type Message,
  type MythosResponse,
} from '../client.js';
import {
  snapshotFiles,
  runSWD,
  printSWDResults,
  parseFileActions,
  dryRunSWD,
  printVerboseParse,
} from '../swd.js';
import {
  appendEntry,
  needsDream,
  printMemoryStatus,
  getMemoryContext,
} from '../memory.js';
import { type EffortLevel, MAX_CORRECTION_RETRIES } from '../config.js';
import { c, Spinner, BANNER, hr, heading, dryRunBadge, verboseBadge } from '../utils.js';
import { SessionBudget } from '../budget.js';

// ── Chat Command Options ─────────────────────────────────────
interface ChatOptions {
  effort?: string;
  maxTokens?: string;
  maxTurns?: string;
  budget?: boolean;      // Commander uses --no-budget → budget=false
  dryRun?: boolean;
  verbose?: boolean;
}

// ── Chat Command ─────────────────────────────────────────────
export async function chatCommand(options: ChatOptions): Promise<void> {
  const effort = (options.effort ?? 'high') as EffortLevel;
  const dryRun = options.dryRun === true;
  const verbose = options.verbose === true;

  // ── Initialize Budget ────────────────────────────────────
  const budgetEnabled = options.budget !== false;
  const budget = new SessionBudget(
    {
      maxTokens: parseInt(options.maxTokens ?? '500000', 10) || 500_000,
      maxTurns: parseInt(options.maxTurns ?? '25', 10) || 25,
    },
    budgetEnabled,
  );

  // ── Banner ───────────────────────────────────────────────
  console.log(BANNER);

  // Mode badges
  const modes: string[] = [];
  modes.push(`${c.dim}effort: ${c.cyan}${effort}${c.reset}`);
  modes.push(`${c.dim}model: ${c.cyan}claude-opus-4-6${c.reset}`);
  modes.push(`${c.dim}swd: ${c.green}active${c.reset}`);
  if (dryRun) modes.push(dryRunBadge());
  if (verbose) modes.push(verboseBadge());
  if (!budgetEnabled) modes.push(`${c.yellow}budget: disabled${c.reset}`);
  console.log(`  ${modes.join(' · ')}`);

  // Budget display
  if (budgetEnabled) {
    const snap = budget.status();
    console.log(
      `${c.dim}  budget: ${c.cyan}${snap.maxTokens.toLocaleString()}${c.dim} token limit · ` +
      `${c.cyan}${snap.maxTurns}${c.dim} turn limit · ` +
      `${c.green}${BUDGET_WARN_PERCENT}%${c.dim} warning threshold${c.reset}`,
    );
  }

  printMemoryStatus();
  console.log(hr());

  const helpItems = [
    `${c.cyan}/exit${c.dim} quit`,
    `${c.cyan}/dream${c.dim} compress memory`,
    `${c.cyan}/budget${c.dim} show budget`,
    `${c.cyan}/clear${c.dim} reset conversation`,
  ];
  console.log(`${c.dim}  Commands: ${helpItems.join(' · ')}${c.reset}\n`);

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: `${c.green}❯${c.reset} `,
  });

  const conversationHistory: Message[] = [];
  const spinner = new Spinner();

  // Inject memory context as first user message context
  const memCtx = getMemoryContext();
  if (memCtx) {
    conversationHistory.push({
      role: 'user',
      content: `[MEMORY CONTEXT — Previous session state]\n${memCtx}\n[/MEMORY CONTEXT]\n\nAcknowledge memory loaded. Ready for instructions.`,
    });
    conversationHistory.push({
      role: 'assistant',
      content: 'Memory loaded. Capybara tier active. Strict Write Discipline engaged. Ready.',
    });
  }

  rl.prompt();

  rl.on('line', async (line: string) => {
    const input = line.trim();

    if (!input) {
      rl.prompt();
      return;
    }

    // ── Handle slash commands ──────────────────────────────
    if (input === '/exit' || input === '/quit' || input === '/q') {
      // Show final budget summary
      if (budgetEnabled && budget.status().turns > 0) {
        console.log(`\n${budget.formatBar()}`);
      }
      console.log(`\n${c.dim}Capybara signing off. 🐾${c.reset}\n`);
      rl.close();
      process.exit(0);
    }

    if (input === '/dream') {
      console.log(`${c.dim}Use ${c.cyan}mythos dream${c.dim} command for memory compression.${c.reset}`);
      rl.prompt();
      return;
    }

    if (input === '/memory') {
      printMemoryStatus();
      rl.prompt();
      return;
    }

    if (input === '/budget') {
      console.log(`\n${budget.formatBar()}`);
      rl.prompt();
      return;
    }

    if (input === '/clear') {
      conversationHistory.length = 0;
      console.log(`${c.dim}Conversation cleared. Memory persists in MEMORY.md.${c.reset}`);
      rl.prompt();
      return;
    }

    // ── Budget Pre-Check ──────────────────────────────────
    const budgetCheck = budget.check();
    if (!budgetCheck.ok) {
      // ── Graceful Save: persist progress before stopping ──
      const summary = budget.formatSessionSummary();
      appendEntry(summary, '⏸ Session paused — budget reached', dryRun);

      const warning = budget.formatWarning();
      if (warning) console.log(`\n${warning}`);
      console.log(`\n${budget.formatBar()}`);
      rl.close();
      process.exit(0);
    }

    // ── Pre-SWD: Snapshot files in CWD ────────────────────
    const cwdFiles = shallowScan(process.cwd());
    const beforeSnapshots = snapshotFiles(cwdFiles);

    // Add user message
    conversationHistory.push({ role: 'user', content: input });

    // ── Stream response ───────────────────────────────────
    spinner.start('Capybara is thinking...');
    let thinkingStarted = false;
    let streamStarted = false;

    try {
      const response = await streamMessage(
        conversationHistory,
        effort,
        // onThinkingDelta
        (delta) => {
          if (!thinkingStarted) {
            spinner.stop();
            process.stdout.write(`\n${c.dim}${c.italic}💭 `);
            thinkingStarted = true;
          }
          if (verbose) {
            // Full thinking output in verbose mode
            process.stdout.write(`${c.dim}${delta}`);
          } else {
            // Condensed thinking in normal mode
            const condensed = delta.replace(/\n/g, ' ').slice(0, 200);
            process.stdout.write(`${c.dim}${condensed}`);
          }
        },
        // onTextDelta
        (delta) => {
          if (!streamStarted) {
            if (thinkingStarted) {
              process.stdout.write(`${c.reset}\n\n`);
            } else {
              spinner.stop();
              process.stdout.write('\n');
            }
            streamStarted = true;
          }
          process.stdout.write(delta);
        },
      );

      if (!streamStarted) {
        spinner.stop();
        process.stdout.write('\n' + response.text);
      }
      process.stdout.write('\n');

      // Add to history
      conversationHistory.push({ role: 'assistant', content: response.text });

      // ── Record budget ──────────────────────────────────
      budget.record(response.inputTokens, response.outputTokens);

      // ── Verbose: Show parse trace ──────────────────────
      if (verbose) {
        printVerboseParse(response.text);
      }

      // ── SWD Check (Normal vs Dry-Run) ──────────────────
      if (dryRun) {
        // Dry-run: preview and ask for confirmation
        const dryResult = await dryRunSWD(response.text);
        if (dryResult.rejected.length > 0) {
          appendEntry(
            `dry-run: ${dryResult.rejected.length} action(s) rejected`,
            '⚠️ User rejected file operations',
            dryRun,
          );
        }
        if (dryResult.accepted.length > 0) {
          appendEntry(
            `dry-run: ${dryResult.accepted.length} action(s) accepted`,
            '✅ User would accept these operations',
            dryRun,
          );
        }
      } else {
        // Normal mode: verify against filesystem
        const swdResult = runSWD(response.text, beforeSnapshots);
        printSWDResults(swdResult);

        // Correction loop
        if (!swdResult.verified && swdResult.correctionPrompt) {
          await correctionLoop(
            conversationHistory,
            swdResult.correctionPrompt,
            beforeSnapshots,
            effort,
            spinner,
            budget,
            dryRun,
          );
        }

        // ── Memory Write ──────────────────────────────────
        const actionSummary = summarizeActions(response.text, input);
        const verifyStatus = swdResult.verified
          ? '✅ verified'
          : `⚠️ ${swdResult.actions.filter((a) => a.status !== 'verified').length} issues`;
        appendEntry(actionSummary, verifyStatus, dryRun);
      }

      // Token usage
      console.log(`\n${formatTokenUsage(response)}`);

      // Budget bar
      console.log(budget.formatBar());

      // Budget warning
      const budgetWarning = budget.formatWarning();
      if (budgetWarning) {
        console.log(`\n${budgetWarning}`);
      }

      // Dream check
      if (needsDream()) {
        console.log(
          `\n${c.yellow}💤 Memory approaching capacity. Run ${c.cyan}mythos dream${c.yellow} to compress.${c.reset}`,
        );
      }
    } catch (err: any) {
      spinner.stop();
      console.error(`\n${c.red}✖ API Error: ${err.message}${c.reset}`);
      // Remove the failed user message from history
      conversationHistory.pop();
    }

    console.log(hr());
    rl.prompt();
  });

  rl.on('close', () => {
    process.exit(0);
  });
}

// ── Correction Loop ──────────────────────────────────────────
async function correctionLoop(
  history: Message[],
  correctionPrompt: string,
  initialSnapshots: Map<string, any>,
  effort: EffortLevel,
  spinner: Spinner,
  budget: SessionBudget,
  dryRun: boolean,
): Promise<void> {
  for (let attempt = 1; attempt <= MAX_CORRECTION_RETRIES; attempt++) {
    // Budget check before correction
    const budgetCheck = budget.check();
    if (!budgetCheck.ok) {
      console.log(`\n${budget.formatWarning()}`);
      console.log(`${c.dim}Correction aborted — budget exhausted.${c.reset}`);
      return;
    }

    console.log(
      `\n${c.yellow}⟲ SWD Correction Turn ${attempt}/${MAX_CORRECTION_RETRIES}${c.reset}`,
    );

    history.push({ role: 'user', content: correctionPrompt });

    spinner.start(`Correction attempt ${attempt}...`);

    try {
      const correctionResponse = await streamMessage(
        history,
        effort,
        undefined,
        (delta) => {
          if (spinner) spinner.stop();
          process.stdout.write(delta);
        },
      );

      process.stdout.write('\n');
      history.push({
        role: 'assistant',
        content: correctionResponse.text,
      });

      // Record budget for correction turn
      budget.record(correctionResponse.inputTokens, correctionResponse.outputTokens);

      const swdResult = runSWD(correctionResponse.text, initialSnapshots);
      printSWDResults(swdResult);

      if (swdResult.verified) {
        console.log(`${c.green}✔ Correction successful.${c.reset}`);
        return;
      }

      if (attempt >= MAX_CORRECTION_RETRIES) {
        console.log(
          `\n${c.red}✖ Max corrections reached. Yielding to human.${c.reset}`,
        );
        appendEntry(
          'SWD: Max corrections reached',
          '❌ Yielded to human after ' + MAX_CORRECTION_RETRIES + ' attempts',
          dryRun,
        );
        return;
      }

      if (swdResult.correctionPrompt) {
        correctionPrompt = swdResult.correctionPrompt.replace(
          /You have \d+ correction attempts remaining\./,
          `You have ${MAX_CORRECTION_RETRIES - attempt} correction attempt(s) remaining.`,
        );
      }
    } catch (err: any) {
      spinner.stop();
      console.error(
        `${c.red}✖ Correction failed: ${err.message}${c.reset}`,
      );
      return;
    }
  }
}

// ── Helpers ──────────────────────────────────────────────────
function shallowScan(dir: string): string[] {
  const results: string[] = [];
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (
        entry.name.startsWith('.') ||
        entry.name === 'node_modules' ||
        entry.name === 'dist'
      ) {
        continue;
      }
      const full = resolve(dir, entry.name);
      if (entry.isFile()) {
        results.push(full);
      }
    }
  } catch {
    // ignore
  }
  return results;
}

function summarizeActions(output: string, userInput: string): string {
  const actions = parseFileActions(output);
  if (actions.length > 0) {
    return actions.map((a) => `${a.operation}: ${a.path}`).join('; ');
  }
  // Fallback: first 80 chars of user input
  return `chat: ${userInput.slice(0, 80)}`;
}

// Import constant for budget display
import { BUDGET_WARN_PERCENT } from '../config.js';
