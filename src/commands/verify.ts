import { readdirSync, statSync, readFileSync, existsSync } from 'node:fs';
import { resolve, relative, join } from 'node:path';
import { createHash } from 'node:crypto';
import { readMemory, initMemory, appendEntry } from '../memory.js';
import { DEFAULT_IGNORE_PATTERNS, MYTHOSIGNORE_FILE } from '../config.js';
import { c, heading, success, warn, error, info, hr, dryRunBadge, theme } from '../utils.js';

export async function verifyCommand(options: { dryRun?: boolean } = {}): Promise<void> {
  const dryRun = options.dryRun === true;
  console.log(heading('SWD Verify — Codebase × Memory Sync'));
  if (dryRun) {
    console.log(`  ${dryRunBadge()} ${c.dim}Memory writes will be previewed, not executed.${c.reset}\n`);
  }

  const cwd = process.cwd();
  initMemory(dryRun);

  const ignorePatterns = loadIgnorePatterns(cwd);

  info('Scanning codebase...');
  const files = walkDirectory(cwd, ignorePatterns);
  console.log(`${c.dim}  Found ${c.cyan}${files.length}${c.dim} files${c.reset}`);

  const { entries, raw } = readMemory();
  console.log(`${c.dim}  Memory has ${c.cyan}${entries.length}${c.dim} entries${c.reset}`);
  console.log();

  const fileMetadata = extractFileMetadata(raw, cwd);
  const mentionedPaths = extractMentionedPaths(entries, cwd);
  const { verified, drifted, missing } = verifyMentionedPaths(mentionedPaths, cwd, entries, fileMetadata);
  const untrackedFiles = getUntrackedFiles(files, mentionedPaths);

  printUntrackedFiles(untrackedFiles, cwd);

  console.log(`\n${hr()}`);
  console.log(
    `${c.bold}Summary:${c.reset} ` +
    `${theme.success}${verified} verified${c.reset} · ` +
    `${theme.warning}${drifted} drifted${c.reset} · ` +
    `${theme.error}${missing} missing${c.reset} · ` +
    `${theme.muted}${untrackedFiles.length} untracked${c.reset}`,
  );

  appendEntry(
    `verify: scanned ${files.length} files`,
    `✅ ${verified} ok, ⚠️ ${drifted} drift, ❌ ${missing} missing`,
    dryRun,
  );

  if (drifted > 0 || missing > 0) {
    console.log(
      `\n${c.yellow}Drift detected. Run ${c.cyan}mythos chat${c.yellow} to reconcile.${c.reset}`,
    );
  } else {
    console.log(`\n${c.green}✔ No missing or drifted memory file references found.${c.reset}`);
  }
}


type MemoryEntry = { action: string; result: string };

function extractFileMetadata(raw: string, cwd: string): Map<string, Record<string, string>> {
  const metaMap = new Map<string, Record<string, string>>();
  const re = /<!-- mythos:file\n([\s\S]*?)-->/g;
  for (const match of raw.matchAll(re)) {
    const lines = match[1]?.trim().split('\n') || [];
    const meta: Record<string, string> = {};
    for (const line of lines) {
      const [k, v] = line.split('=');
      if (k && v) meta[k.trim()] = v.trim();
    }
    if (meta.path) {
      const absPath = resolve(cwd, meta.path);
      metaMap.set(absPath, meta);
    }
  }
  return metaMap;
}

function extractMentionedPaths(entries: MemoryEntry[], cwd: string): Set<string> {
  const mentionedPaths = new Set<string>();
  const re = /(?:CREATE|MODIFY|DELETE|READ):\s*([^;|]+)(?:;|$)/gi;

  for (const entry of entries) {
    for (const match of entry.action.matchAll(re)) {
      const path = match[1]?.trim();
      if (path) mentionedPaths.add(resolve(cwd, path));
    }
  }
  return mentionedPaths;
}

function verifyMentionedPaths(mentionedPaths: Set<string>, cwd: string, entries: MemoryEntry[], fileMetadata: Map<string, Record<string, string>>) {
  let verified = 0;
  let drifted = 0;
  let missing = 0;

  if (mentionedPaths.size > 0) {
    console.log(`${c.bold}File References in Memory:${c.reset}\n`);
    for (const absPath of mentionedPaths) {
      const relPath = relative(cwd, absPath);
      const lastEntry = entries.filter((e) => {
        const re = /(?:CREATE|MODIFY|DELETE|READ):\s*([^;|]+)(?:;|$)/gi;
        for (const match of e.action.matchAll(re)) {
          if (resolve(cwd, match[1]?.trim() || '') === absPath) return true;
        }
        return false;
      }).pop();

      // Extract the specific operation for this path
      let lastOp = '';
      if (lastEntry) {
        const re = /(CREATE|MODIFY|DELETE|READ):\s*([^;|]+)(?:;|$)/gi;
        for (const match of lastEntry.action.matchAll(re)) {
          if (resolve(cwd, match[2]?.trim() || '') === absPath) {
            lastOp = match[1]?.toUpperCase() || '';
          }
        }
      }

      const wasDelete = lastOp === 'DELETE';
      const fileMeta = fileMetadata.get(absPath);

      if (existsSync(absPath)) {
        const stat = statSync(absPath);
        
        if (wasDelete || fileMeta?.exists === 'false') {
          warn(`${relPath} — exists but memory says it was deleted`);
          drifted++;
        } else if (fileMeta?.sha256) {
          const content = readFileSync(absPath);
          const hash = createHash('sha256').update(content).digest('hex');
          if (hash !== fileMeta.sha256) {
            warn(`${relPath} — exists but content drift detected (hash mismatch)`);
            drifted++;
          } else {
            success(`${relPath} — verified by sha256 (${formatSize(stat.size)})`);
            verified++;
          }
        } else if (lastEntry?.result.includes('✅')) {
          success(`${relPath} — verified (${formatSize(stat.size)})`);
          verified++;
        } else {
          warn(`${relPath} — exists but memory shows: ${lastEntry?.result ?? 'no result'}`);
          drifted++;
        }
      } else {
        if (wasDelete || fileMeta?.exists === 'false') {
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
  return { verified, drifted, missing };
}

function getUntrackedFiles(files: string[], mentionedPaths: Set<string>): string[] {
  return files.filter((f) => {
    return !mentionedPaths.has(f);
  });
}

function printUntrackedFiles(untrackedFiles: string[], cwd: string): void {
  if (untrackedFiles.length > 0) {
    console.log(`\n${c.bold}Untracked Files (not in memory):${c.reset}\n`);
    const showMax = 20;
    for (const f of untrackedFiles.slice(0, showMax)) {
      const rel = relative(cwd, f);
      const stat = statSync(f);
      console.log(`  ${c.dim}·${c.reset} ${rel} ${c.dim}(${formatSize(stat.size)})${c.reset}`);
    }
    if (untrackedFiles.length > showMax) {
      console.log(`  ${c.dim}... and ${untrackedFiles.length - showMax} more${c.reset}`);
    }
  }
}

function walkDirectory(dir: string, ignorePatterns: string[]): string[] {
  const results: string[] = [];

  function walk(currentDir: string, depth: number) {
    if (depth > 10) return;

    try {
      const entries = readdirSync(currentDir, { withFileTypes: true });
      for (const entry of entries) {
        const name = entry.name;
        const full = join(currentDir, name);

        if (shouldIgnore(name, full, dir, ignorePatterns)) continue;

        if (entry.isDirectory()) {
          walk(full, depth + 1);
        } else if (entry.isFile()) {
          results.push(full);
        }
      }
    } catch {
    }
  }

  walk(dir, 0);
  return results;
}

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
    if (name.startsWith('.')) return true;
  }
  return false;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / 1048576).toFixed(1)}MB`;
}
