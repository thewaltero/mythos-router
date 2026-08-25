import { readdirSync, statSync, readFileSync, existsSync } from 'node:fs';
import { resolve, relative, join, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import { readMemory, initMemory, appendEntry } from '../memory.js';
import { DEFAULT_IGNORE_PATTERNS, MYTHOSIGNORE_FILE } from '../config.js';
import { c, heading, success, warn, error, info, hr, dryRunBadge, theme } from '../utils.js';
import { runCIVerification } from '../ci/verify.js';
import { printCIVerifyReport } from '../ci/report.js';
import { resolveWorkspace } from '../workspace.js';

type MemoryEntry = {
  action: string;
  result: string;
};

type FileMetadata = Record<string, string>;

type FileOperation = 'CREATE' | 'MODIFY' | 'DELETE' | 'READ' | 'PATCH';

interface ActionReference {
  operation: FileOperation;
  absPath: string;
}

interface LastReference {
  entry: MemoryEntry;
  operation: FileOperation;
}

interface VerifyCounts {
  verified: number;
  drifted: number;
  missing: number;
}

type VerifyStatus = keyof VerifyCounts;

interface VerifyOutcome {
  status: VerifyStatus;
  message: string;
}

export async function verifyCommand(options: { dryRun?: boolean; ci?: boolean; strict?: boolean; json?: boolean; base?: string } = {}): Promise<void> {
  const workspace = resolveWorkspace();
  if (options.ci === true) {
    try {
      const report = runCIVerification({
        base: options.base,
        strict: options.strict === true,
        cwd: workspace.rootDir,
      });
      printCIVerifyReport(report, options.json === true);
      process.exitCode = report.summary.exitCode;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (options.json === true) {
        console.log(JSON.stringify({
          tool: 'mythos-verify-ci',
          error: message,
          exitCode: 2,
        }, null, 2));
      } else {
        error(message);
      }
      process.exitCode = 2;
    }
    return;
  }

  const dryRun = options.dryRun === true;

  console.log(heading('SWD Verify — Codebase × Memory Sync'));

  if (dryRun) {
    console.log(`  ${dryRunBadge()} ${c.dim}Memory writes will be previewed, not executed.${c.reset}\n`);
  }

  const cwd = workspace.rootDir;

  initMemory(dryRun, workspace);

  const ignorePatterns = loadIgnorePatterns(cwd);

  info('Scanning codebase...');
  const files = walkDirectory(cwd, ignorePatterns);
  console.log(`${c.dim}  Found ${c.cyan}${files.length}${c.dim} files${c.reset}`);

  const { entries, raw } = readMemory(workspace);
  console.log(`${c.dim}  Memory has ${c.cyan}${entries.length}${c.dim} entries${c.reset}`);
  console.log();

  const fileMetadata = extractFileMetadata(raw, cwd);
  const mentionedPaths = extractMentionedPaths(entries, cwd);
  const counts = verifyMentionedPaths(mentionedPaths, cwd, entries, fileMetadata);
  const untrackedFiles = getUntrackedFiles(files, mentionedPaths);

  printUntrackedFiles(untrackedFiles, cwd);
  printSummary(counts, untrackedFiles.length);

  appendEntry(
    `verify: scanned ${files.length} files`,
    `✅ ${counts.verified} ok, ⚠️ ${counts.drifted} drift, ❌ ${counts.missing} missing`,
    dryRun,
    workspace,
  );

  if (counts.drifted > 0 || counts.missing > 0) {
    console.log(
      `\n${c.yellow}Drift detected. Run ${c.cyan}mythos chat${c.yellow} to reconcile.${c.reset}`,
    );
  } else {
    console.log(`\n${c.green}✔ No missing or drifted memory file references found.${c.reset}`);
  }
}

function extractFileMetadata(raw: string, cwd: string): Map<string, FileMetadata> {
  const metaMap = new Map<string, FileMetadata>();
  const blockRe = /<!-- mythos:file\n([\s\S]*?)-->/g;

  for (const match of raw.matchAll(blockRe)) {
    const meta = parseMetadataBlock(match[1] ?? '');
    const absPath = meta.path ? normalizeProjectPath(cwd, meta.path) : null;

    if (absPath) {
      metaMap.set(absPath, meta);
    }
  }

  return metaMap;
}

function parseMetadataBlock(block: string): FileMetadata {
  const meta: FileMetadata = {};

  for (const line of block.trim().split('\n')) {
    const eqIdx = line.indexOf('=');
    if (eqIdx === -1) continue;

    const key = line.slice(0, eqIdx).trim();
    const value = line.slice(eqIdx + 1).trim();

    if (key) {
      meta[key] = value;
    }
  }

  return meta;
}

function extractMentionedPaths(entries: MemoryEntry[], cwd: string): Set<string> {
  const mentionedPaths = new Set<string>();

  for (const entry of entries) {
    for (const ref of parseActionReferences(entry.action, cwd)) {
      mentionedPaths.add(ref.absPath);
    }
  }

  return mentionedPaths;
}

function parseActionReferences(action: string, cwd: string): ActionReference[] {
  const refs: ActionReference[] = [];
  const re = /(CREATE|MODIFY|DELETE|READ|PATCH):\s*([^;|]+)(?:;|$)/gi;

  for (const match of action.matchAll(re)) {
    const operation = match[1]?.toUpperCase() as FileOperation | undefined;
    const rawPath = match[2]?.trim();
    const absPath = rawPath ? normalizeProjectPath(cwd, rawPath) : null;

    if (operation && absPath) {
      refs.push({ operation, absPath });
    }
  }

  return refs;
}

function normalizeProjectPath(cwd: string, rawPath: string): string | null {
  const trimmed = rawPath.trim();

  if (!trimmed) return null;

  const absPath = resolve(cwd, trimmed);
  const relPath = relative(cwd, absPath);

  if (relPath.startsWith('..') || isAbsolute(relPath)) {
    return null;
  }

  return absPath;
}

function verifyMentionedPaths(
  mentionedPaths: Set<string>,
  cwd: string,
  entries: MemoryEntry[],
  fileMetadata: Map<string, FileMetadata>,
): VerifyCounts {
  const counts: VerifyCounts = {
    verified: 0,
    drifted: 0,
    missing: 0,
  };

  if (mentionedPaths.size === 0) {
    info('No file operations found in memory.');
    return counts;
  }

  console.log(`${c.bold}File References in Memory:${c.reset}\n`);

  for (const absPath of mentionedPaths) {
    const outcome = verifySinglePath(absPath, cwd, entries, fileMetadata);
    printOutcome(outcome);
    counts[outcome.status]++;
  }

  return counts;
}

function verifySinglePath(
  absPath: string,
  cwd: string,
  entries: MemoryEntry[],
  fileMetadata: Map<string, FileMetadata>,
): VerifyOutcome {
  const relPath = relative(cwd, absPath);
  const lastRef = findLastReferenceForPath(entries, absPath, cwd);
  const fileMeta = fileMetadata.get(absPath);
  const memorySaysDeleted = lastRef?.operation === 'DELETE' || fileMeta?.exists === 'false';

  if (!existsSync(absPath)) {
    return verifyMissingPath(relPath, memorySaysDeleted);
  }

  return verifyExistingPath(absPath, relPath, lastRef?.entry, fileMeta, memorySaysDeleted);
}

function findLastReferenceForPath(
  entries: MemoryEntry[],
  absPath: string,
  cwd: string,
): LastReference | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i]!;
    const refs = parseActionReferences(entry.action, cwd);
    const match = refs.find((ref) => ref.absPath === absPath);

    if (match) {
      return {
        entry,
        operation: match.operation,
      };
    }
  }

  return null;
}

function verifyMissingPath(relPath: string, memorySaysDeleted: boolean): VerifyOutcome {
  if (memorySaysDeleted) {
    return {
      status: 'verified',
      message: `${relPath} — correctly deleted`,
    };
  }

  return {
    status: 'missing',
    message: `${relPath} — missing from filesystem`,
  };
}

function verifyExistingPath(
  absPath: string,
  relPath: string,
  lastEntry: MemoryEntry | undefined,
  fileMeta: FileMetadata | undefined,
  memorySaysDeleted: boolean,
): VerifyOutcome {
  const stat = statSync(absPath);

  if (memorySaysDeleted) {
    return {
      status: 'drifted',
      message: `${relPath} — exists but memory says it was deleted`,
    };
  }

  if (fileMeta?.sha256) {
    return verifyHash(absPath, relPath, stat.size, fileMeta.sha256);
  }

  if (lastEntry?.result.includes('✅')) {
    return {
      status: 'verified',
      message: `${relPath} — verified (${formatSize(stat.size)})`,
    };
  }

  return {
    status: 'drifted',
    message: `${relPath} — exists but memory shows: ${lastEntry?.result ?? 'no result'}`,
  };
}

function verifyHash(
  absPath: string,
  relPath: string,
  sizeBytes: number,
  expectedHash: string,
): VerifyOutcome {
  const content = readFileSync(absPath);
  const actualHash = createHash('sha256').update(content).digest('hex');

  if (actualHash !== expectedHash) {
    return {
      status: 'drifted',
      message: `${relPath} — exists but content drift detected (hash mismatch)`,
    };
  }

  return {
    status: 'verified',
    message: `${relPath} — verified by sha256 (${formatSize(sizeBytes)})`,
  };
}

function printOutcome(outcome: VerifyOutcome): void {
  switch (outcome.status) {
    case 'verified':
      success(outcome.message);
      break;
    case 'drifted':
      warn(outcome.message);
      break;
    case 'missing':
      error(outcome.message);
      break;
  }
}

function getUntrackedFiles(files: string[], mentionedPaths: Set<string>): string[] {
  return files.filter((file) => !mentionedPaths.has(file));
}

function printUntrackedFiles(untrackedFiles: string[], cwd: string): void {
  if (untrackedFiles.length === 0) return;

  console.log(`\n${c.bold}Untracked Files (not in memory):${c.reset}\n`);

  const showMax = 20;

  for (const file of untrackedFiles.slice(0, showMax)) {
    const rel = relative(cwd, file);
    const stat = statSync(file);
    console.log(`  ${c.dim}·${c.reset} ${rel} ${c.dim}(${formatSize(stat.size)})${c.reset}`);
  }

  if (untrackedFiles.length > showMax) {
    console.log(`  ${c.dim}... and ${untrackedFiles.length - showMax} more${c.reset}`);
  }
}

function printSummary(counts: VerifyCounts, untrackedCount: number): void {
  console.log(`\n${hr()}`);
  console.log(
    `${c.bold}Summary:${c.reset} ` +
      `${theme.success}${counts.verified} verified${c.reset} · ` +
      `${theme.warning}${counts.drifted} drifted${c.reset} · ` +
      `${theme.error}${counts.missing} missing${c.reset} · ` +
      `${theme.muted}${untrackedCount} untracked${c.reset}`,
  );
}

function walkDirectory(dir: string, ignorePatterns: string[]): string[] {
  const results: string[] = [];

  function walk(currentDir: string, depth: number): void {
    if (depth > 10) return;

    try {
      const entries = readdirSync(currentDir, { withFileTypes: true });

      for (const entry of entries) {
        const name = entry.name;
        const full = join(currentDir, name);

        if (shouldIgnore(name, ignorePatterns)) continue;

        if (entry.isDirectory()) {
          walk(full, depth + 1);
        } else if (entry.isFile()) {
          results.push(full);
        }
      }
    } catch {
      // Ignore unreadable directories.
    }
  }

  walk(dir, 0);
  return results;
}

function loadIgnorePatterns(cwd: string): string[] {
  const patterns = [...DEFAULT_IGNORE_PATTERNS];
  const ignorePath = resolve(cwd, MYTHOSIGNORE_FILE);

  if (!existsSync(ignorePath)) {
    return patterns;
  }

  const content = readFileSync(ignorePath, 'utf-8');

  for (const line of content.split('\n')) {
    const trimmed = line.trim();

    if (trimmed && !trimmed.startsWith('#')) {
      patterns.push(trimmed);
    }
  }

  return patterns;
}

function shouldIgnore(name: string, patterns: string[]): boolean {
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
