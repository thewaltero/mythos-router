// ─────────────────────────────────────────────────────────────
//  mythos-router :: commands/chat.ts
//  Interactive REPL with Capybara thinking protocol
//  + Budget Limiter + Dry-Run + Verbose modes
// ─────────────────────────────────────────────────────────────

import * as readline from 'node:readline';
import {
  streamMessage,
  formatTokenUsage,
  type Message,
  type MythosResponse,
} from '../client.js';
import {
  SWDEngine,
  parseActions,
  printSWDResults,
  dryRunSWD,
  printVerboseParse,
  resolveSafePath,
  type FileAction,
} from '../swd.js';
import { saveSessionMetric } from '../metrics.js';
import * as path from 'node:path';
import {
  appendEntry,
  appendMetadataBlock,
  needsDream,
  printMemoryStatus,
  getMemoryContext,
} from '../memory.js';
import {
  type EffortLevel,
  MAX_CORRECTION_RETRIES,
  BUDGET_WARN_PERCENT,
  MODELS,
} from '../config.js';
import { c, Spinner, BANNER, hr, heading, dryRunBadge, verboseBadge, error as logError, warn as logWarn, success as logSuccess } from '../utils.js';
import { SessionBudget } from '../budget.js';
import {
  isGitRepo,
  hasUncommittedChanges,
  getCurrentBranch,
  createAndCheckoutBranch,
  commitChanges,
  getLatestHash,
} from '../git.js';

// ── Chat Command Options ─────────────────────────────────────
interface ChatOptions {
  effort?: string;
  maxTokens?: string;
  maxTurns?: string;
  budget?: boolean;      // Commander uses --no-budget → budget=false
  dryRun?: boolean;
  verbose?: boolean;
  branch?: string;
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

  // ── Sandbox Branching ────────────────────────────────────
  let sandboxBranch: string | null = null;
  if (options.branch) {
    if (!isGitRepo()) {
      logError('Not a git repository. Cannot use --branch flag.');
      process.exit(1);
    }

    const current = getCurrentBranch();
    if (current.startsWith('mythos/')) {
      logError(`Already inside a mythos branch session: ${c.bold}${current}${c.reset}`);
      logError('Nested sandboxing is blocked to prevent Git ambiguity.');
      process.exit(1);
    }

    if (hasUncommittedChanges()) {
      logError('Uncommitted changes detected in working tree.');
      logError('Please commit or stash your changes before starting a sandboxed session.');
      process.exit(1);
    }

    // Generate unique branch name: mythos/<name>-YYYYMMDD-HHMM
    const timestampStr = new Date()
      .toISOString()
      .replace(/[-T:]/g, '')
      .slice(0, 12); // YYYYMMDDHHMM
    
    const formattedTimestamp = `${timestampStr.slice(0, 8)}-${timestampStr.slice(8)}`;
    const sanitizedName = options.branch
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '');

    sandboxBranch = `mythos/${sanitizedName}-${formattedTimestamp}`;

    try {
      createAndCheckoutBranch(sandboxBranch);
    } catch (err: any) {
      logError(`Failed to create sandbox branch: ${err.message}`);
      process.exit(1);
    }
  }

  // ── Banner ───────────────────────────────────────────────
  console.log(BANNER);

  // Mode badges
  const modes: string[] = [];
  modes.push(`${c.dim}effort: ${c.cyan}${effort}${c.reset}`);
  modes.push(`${c.dim}model: ${c.cyan}${MODELS[effort]}${c.reset}`);
  modes.push(`${c.dim}swd: ${c.green}active${c.reset}`);
  if (dryRun) modes.push(dryRunBadge());
  if (verbose) modes.push(verboseBadge());
  if (!budgetEnabled) modes.push(`${c.yellow}budget: disabled${c.reset}`);
  console.log(`  ${modes.join(' · ')}`);

  if (sandboxBranch) {
    console.log(`  ${c.green}✔ Sandbox mode enabled${c.reset}`);
    console.log(`  ${c.dim}branch: ${c.bold}${sandboxBranch}${c.reset}`);
  }

  if (dryRun) {
    console.log(`  ${dryRunBadge()} ${c.dim}Filesystem writes previewed. API calls execute normally.${c.reset}`);
  }

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

      if (sandboxBranch) {
        console.log(`\n${c.green}✔ Session complete${c.reset} ${c.dim}(branch: ${c.bold}${sandboxBranch}${c.dim})${c.reset}`);
      }

      // ── Session Finalization (Auto-Commit + Metadata) ──
      await finalizeSession(sandboxBranch, dryRun);

      console.log(`\n${c.dim}Capybara signing off. 🐾${c.reset}\n`);
      shutdown();
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
      
      // Finalize session with metadata
      await finalizeSession(sandboxBranch, dryRun);

      const warning = budget.formatWarning();
      if (warning) console.log(`\n${warning}`);
      console.log(`\n${budget.formatBar()}`);
      shutdown();
    }

    // Add user message
    conversationHistory.push({ role: 'user', content: input });

    // ── Stream response ───────────────────────────────────
    spinner.start('Capybara is thinking...');
    let thinkingStarted = false;
    let streamStarted = false;
    let thinkingTokens = 0;

    try {
      const response = await streamMessage(
        conversationHistory,
        effort,
        // onThinkingDelta
        (delta) => {
          if (!thinkingStarted) {
            if (verbose) {
              spinner.stop();
              process.stdout.write(`\n${c.dim}${c.italic}💭 `);
            }
            thinkingStarted = true;
          }
          if (verbose) {
            // Full thinking output in verbose mode
            process.stdout.write(`${c.dim}${delta}`);
          } else {
            thinkingTokens += Math.ceil(delta.length / 4);
            spinner.update(`Thinking (${MODELS[effort]})... ${c.yellow}~${thinkingTokens} tokens${c.reset}`);
          }
        },
        // onTextDelta
        (delta) => {
          if (!streamStarted) {
            if (thinkingStarted && verbose) {
              process.stdout.write(`${c.reset}\n\n`);
            } else {
              const msg = thinkingTokens > 0 
                ? `${c.green}✔${c.reset} ${c.dim}Thought process complete (~${thinkingTokens} tokens)${c.reset}`
                : `${c.green}✔${c.reset} ${c.dim}Ready${c.reset}`;
              spinner.stop(msg);
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
      const actions = parseActions(response.text);

      if (dryRun) {
        // Dry-run: preview and ask for confirmation
        const dryResult = await dryRunSWD(actions);
        if (dryResult.rejected.length > 0) {
          appendEntry(
            `dry-run: ${dryResult.rejected.length} action(s) rejected`,
            '⚠️ User rejected file operations',
            dryRun,
          );
        }
        // In dry run, we don't actually run the engine for real effects
        if (dryResult.accepted.length > 0) {
           appendEntry(
            `dry-run: ${dryResult.accepted.length} action(s) accepted`,
            '✅ User would accept these operations',
            dryRun,
          );
        }
      } else {
        spinner.start('Verifying and applying changes...');
        
        const engine = new SWDEngine({ 
          strict: true, 
          enableRollback: true,
          onAction: (a) => spinner.update(`Executing: ${c.cyan}${a.operation}${c.reset} ${a.path}...`),
          onVerify: (r) => spinner.update(`Verifying: ${r.action.path}...`),
          onRollback: (p, s, e) => {
            if (s) spinner.update(`Rolled back: ${p}`);
            else spinner.update(`${c.red}Rollback failed${c.reset}: ${p} (${e})`);
          }
        });
        const swdResult = await engine.run(actions);
        
        spinner.stop();
        printSWDResults(swdResult);

        // Correction loop
        if (!swdResult.success) {
          await correctionLoop(
            conversationHistory,
            swdResult,
            effort,
            spinner,
            budget,
            dryRun,
          );
        }

        // ── Memory Write ──────────────────────────────────
        const actionSummary = summarizeActions(response.text, input);
        const verifyStatus = swdResult.success
          ? '✅ verified'
          : `⚠️ ${swdResult.results.filter((r) => r.status !== 'verified').length} issues`;
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

  function shutdown() {
    const snap = budget.status();
    if (snap.totalTokens > 0) {
      saveSessionMetric({
        command: 'chat',
        project: path.basename(process.cwd()),
        inputTokens: snap.inputTokens,
        outputTokens: snap.outputTokens,
        turns: snap.turns,
        costUSD: snap.estimatedCostUSD,
        durationMs: snap.elapsedMs,
        timestamp: new Date().toISOString(),
      });
    }
    rl.close();
    process.exit(0);
  }

  rl.on('close', () => {
    shutdown();
  });
}

// ── Correction Loop ──────────────────────────────────────────
async function correctionLoop(
  history: Message[],
  lastResult: SWDRunResult,
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

    const failures = lastResult.results
      .filter((r) => ['failed', 'drift'].includes(r.status))
      .map((r) => `- [${r.status.toUpperCase()}] ${r.action.operation} ${r.action.path}: ${r.detail}`)
      .join('\n');

    const correctionPrompt = `[SWD CORRECTION TURN]\nFile actions failed verification:\n${failures}\n\nPlease correct your response. Attempts remaining: ${MAX_CORRECTION_RETRIES - (attempt - 1)}`;

    history.push({ role: 'user', content: correctionPrompt });

    spinner.start(`Correction attempt ${attempt}...`);
    let thinkingTokens = 0;
    let streamStarted = false;

    try {
      const correctionResponse = await streamMessage(
        history,
        effort,
        (delta) => {
          thinkingTokens += Math.ceil(delta.length / 4);
          spinner.update(`Correction attempt ${attempt}... ${c.yellow}~${thinkingTokens} tokens${c.reset}`);
        },
        (delta) => {
          if (!streamStarted) {
            spinner.stop(`${c.green}✔${c.reset} ${c.dim}Correction thought process complete${c.reset}`);
            process.stdout.write('\n');
            streamStarted = true;
          }
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

      spinner.start('Running SWD Verification...');
      const engine = new SWDEngine({ 
        strict: true, 
        enableRollback: true,
        onAction: (a) => spinner.update(`Applying: ${c.cyan}${a.operation}${c.reset} ${a.path}...`),
        onVerify: (r) => spinner.update(`Verifying: ${r.action.path}...`),
        onRollback: (p, s, e) => {
          if (s) spinner.update(`Rolled back: ${p}`);
          else spinner.update(`${c.red}Rollback failed${c.reset}: ${p} (${e})`);
        }
      });
      const swdResult = await engine.run(parseActions(correctionResponse.text));
      spinner.stop();
      printSWDResults(swdResult);

      if (swdResult.success) {
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

      // Update for next attempt
      lastResult = swdResult;
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

// Extract file paths referenced in FILE_ACTION blocks and resolve them safely.
// Only these files are snapshotted — avoids hashing the entire project tree.
function extractReferencedPaths(modelOutput: string): string[] {
  const actions = parseActions(modelOutput);
  const paths: string[] = [];
  for (const action of actions) {
    try {
      paths.push(resolveSafePath(action.path));
    } catch {
      // Path traversal blocked — skip silently
    }
  }
  return paths;
}

function summarizeActions(output: string, userInput: string): string {
  const actions = parseActions(output);
  if (actions.length > 0) {
    return actions.map((a) => `${a.operation}: ${a.path}`).join('; ');
  }
  // Fallback: first 80 chars of user input
  return `chat: ${userInput.slice(0, 80)}`;
}

/**
 * Handles deterministic session finalization:
 * 1. Auto-commits changes (if git and dirty)
 * 2. Records commit hash and branch in MEMORY.md metadata block
 */
async function finalizeSession(sandboxBranch: string | null, dryRun: boolean): Promise<void> {
  let commitHash = 'none';
  const repo = isGitRepo();

  if (repo && !dryRun) {
    try {
      if (hasUncommittedChanges()) {
        commitChanges('mythos: session end');
      }
      commitHash = getLatestHash();
    } catch (err: any) {
      logWarn(`Auto-commit failed: ${err.message}`);
    }
  }

  const metadata: Record<string, string> = {
    commit: commitHash,
    branch: sandboxBranch || (repo ? getCurrentBranch() : 'none'),
    timestamp_end: new Date().toISOString(),
  };

  appendMetadataBlock(metadata, dryRun);
}

