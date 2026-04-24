// ─────────────────────────────────────────────────────────────
//  mythos-router :: commands/dream.ts
//  Summarization Dream — Memory compression
// ─────────────────────────────────────────────────────────────

import {
  readMemory,
  writeCompressedMemory,
  getEntryCount,
  initMemory,
  appendEntry,
  type MemoryEntry,
} from '../memory.js';
import { sendMessage } from '../client.js';
import { c, heading, hr, Spinner, success, info, warn, dryRunBadge } from '../utils.js';
import { saveSessionMetric } from '../metrics.js';
import { COST_PER_INPUT_TOKEN, COST_PER_OUTPUT_TOKEN } from '../config.js';
import { calculateCost } from '../providers/pricing.js';
import * as path from 'node:path';

// ── Dream Command ────────────────────────────────────────────
export async function dreamCommand(options: {
  force?: boolean;
  dryRun?: boolean;
}): Promise<void> {
  const dryRun = options.dryRun === true;
  console.log(heading('💤 Summarization Dream'));
  if (dryRun) {
    console.log(`  ${dryRunBadge()} ${c.dim}Memory writes will be previewed, not executed.${c.reset}\n`);
  }

  initMemory();
  const { entries, raw } = readMemory();
  const count = entries.length;

  console.log(`${c.dim}  Current entries: ${c.cyan}${count}${c.reset}`);

  if (count < 10 && !options.force) {
    info('Not enough entries to dream about. Use --force to override.');
    return;
  }

  // Keep the 20 most recent entries as "active memory"
  const keepRecent = 20;
  const toCompress = entries.slice(0, Math.max(0, entries.length - keepRecent));
  const toKeep = entries.slice(-keepRecent);

  if (toCompress.length === 0) {
    info('Nothing to compress. All entries are recent.');
    return;
  }

  console.log(
    `${c.dim}  Compressing: ${c.yellow}${toCompress.length}${c.dim} entries → summary${c.reset}`,
  );
  console.log(
    `${c.dim}  Keeping:     ${c.green}${toKeep.length}${c.dim} recent entries${c.reset}\n`,
  );

  // Build the entries text for summarization
  const entriesText = toCompress
    .map((e) => `| ${e.timestamp} | ${e.action} | ${e.result} |`)
    .join('\n');

  const spinner = new Spinner();
  spinner.start('Dreaming... compressing agentic memory...');

  try {
    const response = await sendMessage(
      [
        {
          role: 'user',
          content:
            `You are the memory compression engine for mythos-router (Capybara tier).\n\n` +
            `Below are ${toCompress.length} log entries from the project's MEMORY.md.\n` +
            `Compress them into a concise summary that preserves:\n` +
            `1. Key architectural decisions made\n` +
            `2. Files created, modified, or deleted\n` +
            `3. Any errors or corrections that occurred\n` +
            `4. The overall trajectory/intent of the session(s)\n\n` +
            `Output a clear, scannable markdown summary (bullet points preferred).\n` +
            `Do NOT include a table. Do NOT include timestamps for individual items.\n` +
            `This summary will be injected as context for future sessions.\n\n` +
            `---\n\n` +
            `| Timestamp | Action | Verified Result |\n` +
            `|-----------|--------|----------------|\n` +
            entriesText,
        },
      ],
      'low', // low effort for summarization — save tokens
      'You are a memory compression engine. Output only the summary, nothing else.',
    );

    spinner.stop();

    const summary = response.text.trim();

    // Write compressed memory
    writeCompressedMemory(summary, toKeep, dryRun);

    // Stats
    const beforeSize = raw.length;
    const { raw: afterRaw } = readMemory();
    const afterSize = afterRaw.length;
    const ratio = ((1 - afterSize / beforeSize) * 100).toFixed(1);

    console.log(`\n${c.bold}Dream Summary:${c.reset}\n`);
    console.log(`${c.dim}${summary}${c.reset}`);
    console.log(`\n${hr()}`);
    success(
      `Compressed ${toCompress.length} entries → summary block`,
    );
    console.log(
      `${c.dim}  Before: ${beforeSize} chars → After: ${afterSize} chars (${ratio}% reduction)${c.reset}`,
    );
    console.log(
      `${c.dim}  Tokens used: ${c.cyan}${response.inputTokens + response.outputTokens}${c.reset}`,
    );

    appendEntry(
      `dream: compressed ${toCompress.length} entries`,
      `✅ ${ratio}% reduction`,
      dryRun,
    );
    // Save metric
    let costUSD = 0;
    if (response._orchestration?.modelId) {
      costUSD = calculateCost(
        response._orchestration.modelId,
        response.inputTokens,
        response.outputTokens
      );
    } else {
      costUSD = (response.inputTokens * COST_PER_INPUT_TOKEN) + (response.outputTokens * COST_PER_OUTPUT_TOKEN);
    }
    saveSessionMetric({
      command: 'dream',
      project: path.basename(process.cwd()),
      inputTokens: response.inputTokens,
      outputTokens: response.outputTokens,
      turns: 1,
      costUSD,
      durationMs: 0, // Not easily trackable without start time, 0 is fine
      timestamp: new Date().toISOString(),
    });

  } catch (err: any) {
    spinner.stop();
    console.error(`\n${c.red}✖ Dream failed: ${err.message}${c.reset}`);

    if (err.message?.includes('ANTHROPIC_API_KEY')) {
      warn('API key required for Dream compression (uses Claude to summarize).');
    }
  }
}
