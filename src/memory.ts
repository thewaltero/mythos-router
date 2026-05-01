// ─────────────────────────────────────────────────────────────
//  mythos-router :: memory.ts
//  Self-Healing Memory — Authority-Based Derivative Indexing
// ─────────────────────────────────────────────────────────────

import { readFileSync, writeFileSync, existsSync, statSync, appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { getDatabaseSync } from './sqlite-loader.js';
import { MEMORY_FILE, MEMORY_DB_FILE, MEMORY_MAX_LINES } from './config.js';
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

export function getDbPath(): string {
  return resolve(process.cwd(), MEMORY_DB_FILE);
}

// ── Integrity & Signpost Check ────────────────────────────────
/**
 * Calculates a SHA-256 hash of the entire MEMORY.md file.
 * This is the "Sole Authority" for data integrity.
 */
function getMemoryHash(): string {
  const path = getMemoryPath();
  if (!existsSync(path)) return 'none';
  const content = readFileSync(path, 'utf-8');
  return createHash('sha256').update(content).digest('hex');
}

// ── Derivative Index Lifecycle (Non-authoritative) ────────────
/**
 * THE DERIVATIVE INDEX RULE:
 * 1. Authority: MEMORY.md is the ONLY source of truth.
 * 2. Purgeability: This SQLite database is fully disposable and non-authoritative.
 *    It can be deleted or rebuilt at any time without loss of information.
 * 3. Failure Isolation: A database failure MUST NEVER affect system correctness.
 *    If SQLite fails, the system continues with reduced search performance.
 */
let _db: InstanceType<ReturnType<typeof getDatabaseSync>> | null = null;

/**
 * Returns the open SQLite database instance.
 * Initializes schema and triggers if needed.
 */
function getDb(): InstanceType<ReturnType<typeof getDatabaseSync>> {
  if (_db) return _db;

  const DatabaseSync = getDatabaseSync();
  const path = getDbPath();
  _db = new DatabaseSync(path);

  // WAL mode for better concurrency and safety
  _db.exec('PRAGMA journal_mode=WAL;');

  /**
   * Authority Rule: SQLite is a derivative index.
   * We use a sync_cache table to store the last known manifest hash of MEMORY.md.
   */
  _db.exec(`
    CREATE TABLE IF NOT EXISTS sync_cache (
      key TEXT PRIMARY KEY,
      value TEXT
    );

    CREATE TABLE IF NOT EXISTS memory (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT NOT NULL,
      action TEXT NOT NULL,
      result TEXT NOT NULL,
      tags TEXT,
      metadata TEXT
    );

    -- FTS5 for intelligent retrieval
    CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
      action, 
      result, 
      content='memory', 
      content_rowid='id',
      tokenize="unicode61"
    );

    -- Lifecycle Triggers
    CREATE TRIGGER IF NOT EXISTS memory_ai AFTER INSERT ON memory BEGIN
      INSERT INTO memory_fts(rowid, action, result) VALUES (new.id, new.action, new.result);
    END;
    CREATE TRIGGER IF NOT EXISTS memory_ad AFTER DELETE ON memory BEGIN
      DELETE FROM memory_fts WHERE rowid = old.id;
    END;
    CREATE TRIGGER IF NOT EXISTS memory_au AFTER UPDATE ON memory BEGIN
      DELETE FROM memory_fts WHERE rowid = old.id;
      INSERT INTO memory_fts(rowid, action, result) VALUES (new.id, new.action, new.result);
    END;
  `);

  return _db;
}

/**
 * Unconditionally rebuilds the SQLite index artifact from MEMORY.md.
 * This is the "Recovery Path" for data integrity.
 */
export function rebuildIndex(dryRun = false): void {
  const mdPath = getMemoryPath();
  if (!existsSync(mdPath)) return;

  if (dryRun) {
    console.log(`${dryRunBadge()} ${c.dim}Would rebuild memory index from MEMORY.md${c.reset}`);
    return;
  }

  const db = getDb();
  const entries = parseMemoryFile();

  // Atomic Reconstruction
  db.exec('BEGIN;');
  try {
    db.exec('DELETE FROM memory;');
    db.exec('DELETE FROM memory_fts;');

    const insert = db.prepare(`
      INSERT INTO memory (timestamp, action, result)
      VALUES (?, ?, ?)
    `);

    for (const entry of entries) {
      insert.run(entry.timestamp, entry.action, entry.result);
    }

    // Update signpost (The "Truth Hash")
    const hash = getMemoryHash();
    db.prepare('INSERT OR REPLACE INTO sync_cache (key, value) VALUES (?, ?)')
      .run('manifest_hash', hash);

    db.exec('COMMIT;');
    success(`Memory index rebuilt (${entries.length} entries)`);
  } catch (err: any) {
    db.exec('ROLLBACK;');
    throw err;
  }
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

  // Authority Check: Startup-only reconciliation
  if (!dryRun) {
    try {
      const db = getDb();
      const storedHashRow = db.prepare('SELECT value FROM sync_cache WHERE key = ?').get('manifest_hash') as { value: string } | undefined;
      const currentHash = getMemoryHash();

      if (!storedHashRow || storedHashRow.value !== currentHash) {
        if (!storedHashRow) {
          info('Initializing memory index...');
        } else {
          warn('Memory index out of sync — rebuilding...');
        }
        rebuildIndex();
      }
    } catch (err: any) {
      warn(`Failed to verify memory index: ${err.message}`);
    }
  }
}

// ── Append a single entry ────────────────────────────────────
export function appendEntry(action: string, result: string, dryRun = false): void {
  initMemory(dryRun);
  const path = getMemoryPath();
  const ts = timestamp();
  const sanitizedAction = sanitize(action);
  const sanitizedResult = sanitize(result);
  const line = `| ${ts} | ${sanitizedAction} | ${sanitizedResult} |`;

  if (dryRun) {
    console.log(`${dryRunBadge()} ${c.dim}Would append to MEMORY.md:${c.reset} ${c.cyan}${sanitizedAction}${c.reset} → ${c.dim}${sanitizedResult}${c.reset}`);
    return;
  }

  // 1. Markdown First (Sole Authority)
  // Standard appendFileSync is O(1) and safer than rewriting the whole file.
  appendFileSync(path, line + '\n', 'utf-8');

  // 2. Best-effort DB Indexing (Failure Isolated)
  // If this step fails, system correctness is untouched.
  try {
    const db = getDb();
    const insert = db.prepare('INSERT INTO memory (timestamp, action, result) VALUES (?, ?, ?)');
    insert.run(ts, sanitizedAction, sanitizedResult);

    // Update Signpost
    const hash = getMemoryHash();
    db.prepare('INSERT OR REPLACE INTO sync_cache (key, value) VALUES (?, ?)')
      .run('manifest_hash', hash);
  } catch (err: any) {
    warn(`Failed to update memory index: ${err.message}`);
  }
}

/**
 * Appends a hidden metadata block to MEMORY.md for machine parsing.
 */
export function appendMetadataBlock(metadata: Record<string, string>, dryRun = false): void {
  initMemory(dryRun);
  const path = getMemoryPath();
  
  let block = '\n<!-- mythos:meta\n';
  for (const [key, value] of Object.entries(metadata)) {
    block += `${key}=${value}\n`;
  }
  block += '-->\n\n';

  if (dryRun) {
    console.log(`${dryRunBadge()} ${c.dim}Would append metadata block to MEMORY.md:${c.reset}`);
    const preview = block.trim().split('\n').map(l => `  ${l}`).join('\n');
    console.log(`${c.cyan}${preview}${c.reset}`);
    return;
  }

  appendFileSync(path, block, 'utf-8');

  // Update signpost so the next initMemory() doesn't think the index is out of sync
  try {
    const db = getDb();
    const hash = getMemoryHash();
    db.prepare('INSERT OR REPLACE INTO sync_cache (key, value) VALUES (?, ?)')
      .run('manifest_hash', hash);
  } catch {
    // Ignore, derivative index is non-authoritative
  }
}

/**
 * Surgical retrieval from the derivative SQLite index using FTS5.
 * Returns ranked results matching the query.
 */
export function searchMemory(query: string, options?: { createIfMissing?: boolean }): MemoryEntry[] {
  if (options?.createIfMissing === false) {
    if (!existsSync(getDbPath())) return [];
  }

  try {
    const db = getDb();
    // Use FTS5 ranked search
    const results = db.prepare(`
      SELECT m.* 
      FROM memory m
      JOIN memory_fts f ON m.id = f.rowid
      WHERE memory_fts MATCH ?
      ORDER BY rank
      LIMIT 20
    `).all(query) as any[];

    return results.map(r => ({
      timestamp: r.timestamp,
      action: r.action,
      result: r.result
    }));
  } catch (err: any) {
    warn(`search failed (falling back to empty): ${err.message}`);
    return [];
  }
}

/**
 * Lower-level helper to parse MEMORY.md content directly.
 * Used by rebuildIndex to avoid infinite recursion with initMemory.
 */
function parseMemoryFile(): MemoryEntry[] {
  const path = getMemoryPath();
  if (!existsSync(path)) return [];
  const raw = readFileSync(path, 'utf-8');
  const lines = raw.split('\n');

  const entries: MemoryEntry[] = [];
  for (const line of lines) {
    if (line.startsWith('|') && !line.includes('---') && !line.includes('Timestamp')) {
      const cols = line.split('|').map((s) => s.trim()).filter(Boolean);
      if (cols.length >= 3) {
        entries.push({
          timestamp: cols[0]!,
          action: cols[1]!,
          result: cols[2]!,
        });
      }
    }
  }
  return entries;
}

// ── Read all entries ─────────────────────────────────────────
export function readMemory(): { header: string; entries: MemoryEntry[]; raw: string } {
  const path = getMemoryPath();

  // Do NOT call initMemory() here — reads must never create files.
  // This ensures dry-run commands stay truly non-mutating.
  if (!existsSync(path)) {
    return { header: '', entries: [], raw: '' };
  }

  const raw = readFileSync(path, 'utf-8');
  const lines = raw.split('\n');

  const entries = parseMemoryFile();
  const headerLines: string[] = [];

  for (const line of lines) {
    if (line.startsWith('|') && !line.includes('---') && !line.includes('Timestamp')) {
      break;
    }
    headerLines.push(line);
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

  // Rebuild search index to reflect the compressed memory
  try {
    rebuildIndex();
  } catch (err: any) {
    warn(`Failed to rebuild memory index after dream: ${err.message}`);
  }
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
