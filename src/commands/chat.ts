// ─────────────────────────────────────────────────────────────
//  mythos-router :: commands/chat.ts
//  Interactive REPL with Capybara thinking protocol
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
} from '../swd.js';
import {
  appendEntry,
  needsDream,
  printMemoryStatus,
  getMemoryContext,
} from '../memory.js';
import { type EffortLevel, MAX_CORRECTION_RETRIES } from '../config.js';
import { c, Spinner, BANNER, hr, heading } from '../utils.js';

// ── Chat Command ─────────────────────────────────────────────
export async function chatCommand(options: {
  effort?: string;
}): Promise<void> {
  const effort = (options.effort ?? 'high') as EffortLevel;

  console.log(BANNER);
  console.log(
    `${c.dim}  effort: ${c.cyan}${effort}${c.dim} · model: ${c.cyan}claude-opus-4-6${c.dim} · swd: ${c.green}active${c.reset}`,
  );
  printMemoryStatus();
  console.log(hr());
  console.log(
    `${c.dim}  Type your message. Use ${c.cyan}/exit${c.dim} to quit, ${c.cyan}/dream${c.dim} to compress memory.${c.reset}\n`,
  );

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

    // Handle commands
    if (input === '/exit' || input === '/quit' || input === '/q') {
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

    if (input === '/clear') {
      conversationHistory.length = 0;
      console.log(`${c.dim}Conversation cleared. Memory persists in MEMORY.md.${c.reset}`);
      rl.prompt();
      return;
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
          // Show a condensed version of thinking
          const condensed = delta.replace(/\n/g, ' ').slice(0, 200);
          process.stdout.write(`${c.dim}${condensed}`);
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

      // ── SWD Check ───────────────────────────────────────
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
        );
      }

      // ── Memory Write ────────────────────────────────────
      const actionSummary = summarizeActions(response.text, input);
      const verifyStatus = swdResult.verified
        ? '✅ verified'
        : `⚠️ ${swdResult.actions.filter((a) => a.status !== 'verified').length} issues`;
      appendEntry(actionSummary, verifyStatus);

      // Token usage
      console.log(`\n${formatTokenUsage(response)}`);

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
): Promise<void> {
  for (let attempt = 1; attempt <= MAX_CORRECTION_RETRIES; attempt++) {
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
