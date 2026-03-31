// ─────────────────────────────────────────────────────────────
//  mythos-router :: commands/verify.ts
//  Codebase ↔ MEMORY.md drift scanner
// ─────────────────────────────────────────────────────────────

import { readdirSync, statSync, readFileSync, existsSync } from 'node:fs';
import { resolve, relative, join } from 'node:path';
import { createHash } from 'node:crypto';
import { readMemory, initMemory, appendEntry, getMemoryPath } from '../memory.js';
import { DEFAULT_IGNORE_PATTERNS, MYTHOSIGNORE_FILE } from '../config.js';
import { c, heading, success, warn, error, info, hr, timestamp } from '../utils.js';

// ── Verify Command ───────────────────────────────────────────
export async function verifyCommand(): Promise<void> {
  console.log(heading('SWD Verify — Codebase × Memory Sync'));

  const cwd = process.cwd();
  initMemory();

  // Load ignore patterns
  const ignorePatterns = loadIgnorePatterns(cwd);

  // Scan codebase
  info('Scanning codebase...');
  const files = walkDirectory(cwd, ignorePatterns);
  console.log(`${c.dim}  Found ${c.cyan}${files.length}${c.dim} files${c.reset}`);

  // Read memory
  const { entries, raw } = readMemory();
  console.log(`${c.dim}  Memory has ${c.cyan}${entries.length}${c.dim} entries${c.reset}`);
  console.log();

  // Extract file paths mentioned in memory
  const mentionedPaths = new Set<string>();
  for (const entry of entries) {
    // Parse paths from action column
    const pathMatches = entry.action.match(
      /(?:CREATE|MODIFY|DELETE|READ|chat):\s*(.+?)(?:;|$)/gi,
    );
    if (pathMatches) {
      for (const match of pathMatches) {
        const path = match.replace(/^(?:CREATE|MODIFY|DELETE|READ|chat):\s*/i, '').trim();
        if (path && !path.startsWith('chat:')) {
          mentionedPaths.add(path);
        }
      }
    }
  }

  // ── Verify each mentioned path ─────────────────────────
  let verified = 0;
  let drifted = 0;
  let missing = 0;

  if (mentionedPaths.size > 0) {
    console.log(`${c.bold}File References in Memory:${c.reset}\n`);

    for (const rawPath of mentionedPaths) {
      const absPath = resolve(cwd, rawPath);
      const relPath = relative(cwd, absPath);

      if (existsSync(absPath)) {
        const stat = statSync(absPath);
        const hash = hashFile(absPath);

        // Check if the most recent memory entry for this file reflects current state
        const lastEntry = entries
          .filter((e) => e.action.includes(rawPath))
          .pop();

        if (lastEntry?.result.includes('✅')) {
          success(`${relPath} — verified (${formatSize(stat.size)})`);
          verified++;
        } else {
          warn(`${relPath} — exists but memory shows: ${lastEntry?.result ?? 'no result'}`);
          drifted++;
        }
      } else {
        // Check if it was supposed to be deleted
        const lastEntry = entries
          .filter((e) => e.action.includes(rawPath))
          .pop();

        if (lastEntry?.action.includes('DELETE')) {
          success(`${relPath} — correctly deleted`);
          verified++;
        } else {
          error(`${relPath} — missing from filesystem`);
          missing++;
        }
      }
    }
  } else {
    info('No file operations found in memory.');
  }

  // ── Untracked files ────────────────────────────────────
  const untrackedFiles = files.filter((f) => {
    const rel = relative(cwd, f);
    return !mentionedPaths.has(rel) && !mentionedPaths.has(f);
  });

  if (untrackedFiles.length > 0) {
    console.log(`\n${c.bold}Untracked Files (not in memory):${c.reset}\n`);
    const showMax = 20;
    for (const f of untrackedFiles.slice(0, showMax)) {
      const rel = relative(cwd, f);
      const stat = statSync(f);
      console.log(`  ${c.dim}·${c.reset} ${rel} ${c.dim}(${formatSize(stat.size)})${c.reset}`);
    }
    if (untrackedFiles.length > showMax) {
      console.log(
        `  ${c.dim}... and ${untrackedFiles.length - showMax} more${c.reset}`,
      );
    }
  }

  // ── Summary ────────────────────────────────────────────
  console.log(`\n${hr()}`);
  console.log(
    `${c.bold}Summary:${c.reset} ` +
      `${c.green}${verified} verified${c.reset} · ` +
      `${c.yellow}${drifted} drift${c.reset} · ` +
      `${c.red}${missing} missing${c.reset} · ` +
      `${c.dim}${untrackedFiles.length} untracked${c.reset}`,
  );

  // Log verification to memory
  appendEntry(
    `verify: scanned ${files.length} files`,
    `✅ ${verified} ok, ⚠️ ${drifted} drift, ❌ ${missing} missing`,
  );

  if (drifted > 0 || missing > 0) {
    console.log(
      `\n${c.yellow}Drift detected. Run ${c.cyan}mythos chat${c.yellow} to reconcile.${c.reset}`,
    );
  } else {
    console.log(`\n${c.green}✔ Zero drift. Memory and codebase are in sync.${c.reset}`);
  }
}

// ── Directory Walker ─────────────────────────────────────────
function walkDirectory(dir: string, ignorePatterns: string[]): string[] {
  const results: string[] = [];

  function walk(currentDir: string, depth: number) {
    if (depth > 10) return; // safety limit

    try {
      const entries = readdirSync(currentDir, { withFileTypes: true });
      for (const entry of entries) {
        const name = entry.name;
        const full = join(currentDir, name);

        // Check against ignore patterns
        if (shouldIgnore(name, full, dir, ignorePatterns)) continue;

        if (entry.isDirectory()) {
          walk(full, depth + 1);
        } else if (entry.isFile()) {
          results.push(full);
        }
      }
    } catch {
      // Permission denied, etc.
    }
  }

  walk(dir, 0);
  return results;
}

// ── Ignore logic ─────────────────────────────────────────────
function loadIgnorePatterns(cwd: string): string[] {
  const patterns = [...DEFAULT_IGNORE_PATTERNS];
  const ignorePath = resolve(cwd, MYTHOSIGNORE_FILE);
  if (existsSync(ignorePath)) {
    const content = readFileSync(ignorePath, 'utf-8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith('#')) {
        patterns.push(trimmed);
      }
    }
  }
  return patterns;
}

function shouldIgnore(
  name: string,
  fullPath: string,
  rootDir: string,
  patterns: string[],
): boolean {
  for (const pattern of patterns) {
    if (name === pattern) return true;
    if (pattern.startsWith('*.') && name.endsWith(pattern.slice(1))) return true;
    if (name.startsWith('.') && !pattern.startsWith('.')) continue;
    if (name.startsWith('.')) return true; // ignore hidden by default
  }
  return false;
}

// ── Utilities ────────────────────────────────────────────────
function hashFile(path: string): string {
  try {
    const content = readFileSync(path);
    return createHash('sha256').update(content).digest('hex').slice(0, 16);
  } catch {
    return 'error';
  }
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / 1048576).toFixed(1)}MB`;
}
