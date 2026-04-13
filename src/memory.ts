// ─────────────────────────────────────────────────────────────
//  mythos-router :: memory.ts
//  Self-Healing Memory — MEMORY.md management
// ─────────────────────────────────────────────────────────────

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { MEMORY_FILE, MEMORY_MAX_LINES } from './config.js';
import { timestamp, c, info, success, warn, dryRunBadge } from './utils.js';

// ── Types ────────────────────────────────────────────────────
export interface MemoryEntry {
  timestamp: string;
  action: string;
  result: string;
}

// ── Path resolution ──────────────────────────────────────────
export function getMemoryPath(): string {
  return resolve(process.cwd(), MEMORY_FILE);
}

// ── Initialize MEMORY.md if it doesn't exist ─────────────────
export function initMemory(dryRun = false): void {
  const path = getMemoryPath();
  if (!existsSync(path)) {
    if (dryRun) {
      console.log(`${dryRunBadge()} ${c.dim}Would create MEMORY.md (not yet initialized)${c.reset}`);
      return;
    }
    const header =
      `# 🧠 MEMORY.md — mythos-router Agentic Memory\n\n` +
      `> Auto-managed by the Capybara tier. Each model turn is logged.\n` +
      `> When entries exceed ${MEMORY_MAX_LINES} entries, a "Dream" compresses older context.\n\n` +
      `---\n\n` +
      `| Timestamp | Action | Verified Result |\n` +
      `|-----------|--------|----------------|\n`;
    writeFileSync(path, header, 'utf-8');
  }
}

// ── Append a single entry ────────────────────────────────────
export function appendEntry(action: string, result: string, dryRun = false): void {
  initMemory(dryRun);
  const path = getMemoryPath();
  const ts = timestamp();
  const line = `| ${ts} | ${sanitize(action)} | ${sanitize(result)} |`;

  if (dryRun) {
    console.log(`${dryRunBadge()} ${c.dim}Would append to MEMORY.md:${c.reset} ${c.cyan}${sanitize(action)}${c.reset} → ${c.dim}${sanitize(result)}${c.reset}`);
    return;
  }

  const content = readFileSync(path, 'utf-8');
  writeFileSync(path, content + line + '\n', 'utf-8');
}

// ── Read all entries ─────────────────────────────────────────
export function readMemory(): { header: string; entries: MemoryEntry[]; raw: string } {
  initMemory();
  const path = getMemoryPath();
  const raw = readFileSync(path, 'utf-8');
  const lines = raw.split('\n');

  const entries: MemoryEntry[] = [];
  const headerLines: string[] = [];
  let pastHeader = false;

  for (const line of lines) {
    // Table rows start with |
    if (line.startsWith('|') && !line.includes('---') && !line.includes('Timestamp')) {
      pastHeader = true;
      const cols = line.split('|').map((s) => s.trim()).filter(Boolean);
      if (cols.length >= 3) {
        entries.push({
          timestamp: cols[0]!,
          action: cols[1]!,
          result: cols[2]!,
        });
      }
    } else if (!pastHeader) {
      headerLines.push(line);
    }
  }

  return {
    header: headerLines.join('\n'),
    entries,
    raw,
  };
}

// ── Count entry lines ────────────────────────────────────────
export function getEntryCount(): number {
  const { entries } = readMemory();
  return entries.length;
}

// ── Check if Dream is needed ─────────────────────────────────
export function needsDream(): boolean {
  return getEntryCount() > MEMORY_MAX_LINES;
}

// ── Write compressed memory ──────────────────────────────────
export function writeCompressedMemory(
  summary: string,
  recentEntries: MemoryEntry[],
  dryRun = false,
): void {
  const path = getMemoryPath();
  const ts = timestamp();

  let content =
    `# 🧠 MEMORY.md — mythos-router Agentic Memory\n\n` +
    `> Auto-managed by the Capybara tier.\n\n` +
    `---\n\n` +
    `## 💤 Dream Summary (Compressed ${ts})\n\n` +
    `${summary}\n\n` +
    `---\n\n` +
    `## Recent Entries\n\n` +
    `| Timestamp | Action | Verified Result |\n` +
    `|-----------|--------|----------------|\n`;

  for (const entry of recentEntries) {
    content += `| ${entry.timestamp} | ${entry.action} | ${entry.result} |\n`;
  }

  if (dryRun) {
    console.log(`${dryRunBadge()} ${c.dim}Would compress MEMORY.md:${c.reset}`);
    console.log(`${c.dim}  Summary: ${summary.slice(0, 120)}...${c.reset}`);
    console.log(`${c.dim}  Keeping ${recentEntries.length} recent entries${c.reset}`);
    return;
  }

  writeFileSync(path, content, 'utf-8');
}

// ── Get memory context for system prompt injection ───────────
export function getMemoryContext(maxChars = 4000): string {
  try {
    const { raw } = readMemory();
    if (raw.length <= maxChars) return raw;
    // Return the last maxChars characters (most recent context)
    return '…[truncated]\n' + raw.slice(-maxChars);
  } catch {
    return '';
  }
}

// ── Print memory status ──────────────────────────────────────
export function printMemoryStatus(): void {
  const path = getMemoryPath();
  if (!existsSync(path)) {
    info(`No MEMORY.md found at ${c.dim}${path}${c.reset}`);
    return;
  }
  const { entries, raw } = readMemory();
  const hasSummary = raw.includes('## 💤 Dream Summary');
  console.log(
    `${c.dim}memory:${c.reset} ${c.cyan}${entries.length}${c.reset} entries` +
      (hasSummary ? ` ${c.magenta}(has dream summary)${c.reset}` : '') +
      (needsDream() ? ` ${c.yellow}(dream recommended)${c.reset}` : ''),
  );
}

// ── Sanitize for table ───────────────────────────────────────
function sanitize(text: string): string {
  return text
    .replace(/\|/g, '∣')
    .replace(/\n/g, ' ')
    .slice(0, 120);
}
