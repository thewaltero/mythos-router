// ─────────────────────────────────────────────────────────────
//  mythos-router :: cache.ts
//  Deterministic Response Cache — SQLite-backed
//
//  Rules:
//  - SDK utility only. Not actively wired into CLI commands by default.
//  - Use for pure reasoning tasks with deterministic inputs.
//  - Tool invocations BYPASS the cache entirely
//  - Keys use canonical JSON (sorted keys) + SHA-256
//  - TTL-based expiration (default: 1 hour)
// ─────────────────────────────────────────────────────────────

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { createHash } from 'node:crypto';
import type { UnifiedResponse } from './providers/types.js';
import { getDatabaseSync } from './sqlite-loader.js';

// ── Constants ────────────────────────────────────────────────
const CACHE_DIR = path.join(os.homedir(), '.mythos-router');
const CACHE_DB_FILE = path.join(CACHE_DIR, 'cache.db');
const DEFAULT_TTL_MS = 60 * 60 * 1000; // 1 hour

// ── Canonical JSON Stringify (sorted keys) ───────────────────
// Ensures identical objects always produce the same string,
// regardless of key insertion order.
function canonicalStringify(obj: unknown): string {
  if (obj === null || typeof obj !== 'object') {
    return JSON.stringify(obj);
  }

  if (Array.isArray(obj)) {
    return '[' + obj.map(item => canonicalStringify(item)).join(',') + ']';
  }

  const sorted = Object.keys(obj as Record<string, unknown>).sort();
  const pairs = sorted.map(key => {
    const val = (obj as Record<string, unknown>)[key];
    return `${JSON.stringify(key)}:${canonicalStringify(val)}`;
  });
  return '{' + pairs.join(',') + '}';
}

// ── Cache Key Generator ──────────────────────────────────────
export interface CacheKeyInput {
  model: string;
  systemPrompt: string;
  messages: Array<{ role: string; content: string }>;
}

export function generateCacheKey(input: CacheKeyInput): string {
  const payload = canonicalStringify(input);
  return createHash('sha256').update(payload).digest('hex');
}

// ── Response Cache ───────────────────────────────────────────
export class ResponseCache {
  private db: InstanceType<ReturnType<typeof getDatabaseSync>> | null = null;
  private ttlMs: number;
  private enabled: boolean;

  constructor(ttlMs: number = DEFAULT_TTL_MS, enabled: boolean = true) {
    this.ttlMs = ttlMs;
    this.enabled = enabled;
  }

  // ── Lazy Initialization ──────────────────────────────────
  private ensureDb(): InstanceType<ReturnType<typeof getDatabaseSync>> {
    if (this.db) return this.db;

    try {
      const DatabaseSync = getDatabaseSync();

      if (!fs.existsSync(CACHE_DIR)) {
        fs.mkdirSync(CACHE_DIR, { recursive: true });
      }

      this.db = new DatabaseSync(CACHE_DB_FILE);
      this.db!.exec(`
        CREATE TABLE IF NOT EXISTS cache_entries (
          key TEXT PRIMARY KEY,
          response TEXT NOT NULL,
          model TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          hit_count INTEGER DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS idx_cache_created ON cache_entries(created_at);
      `);

      return this.db!;
    } catch {
      // SQLite not available — cache is a no-op
      this.enabled = false;
      throw new Error('SQLite not available for caching');
    }
  }

  // ── Get cached response ──────────────────────────────────
  get(key: string): UnifiedResponse | null {
    if (!this.enabled) return null;

    try {
      const db = this.ensureDb();
      const now = Date.now();
      const cutoff = now - this.ttlMs;

      const stmt = db.prepare(
        'SELECT response, created_at FROM cache_entries WHERE key = ? AND created_at > ?'
      );
      const row = stmt.get(key, cutoff) as { response: string; created_at: number } | undefined;

      if (!row) return null;

      // Update hit count
      db.prepare('UPDATE cache_entries SET hit_count = hit_count + 1 WHERE key = ?').run(key);

      return JSON.parse(row.response) as UnifiedResponse;
    } catch {
      return null;
    }
  }

  // ── Store response in cache ──────────────────────────────
  // INVARIANT: Responses with tool calls are NEVER cached.
  set(key: string, response: UnifiedResponse, model: string): void {
    if (!this.enabled) return;

    // Tool Invocation Bypass — never cache responses with tool calls
    if (response.toolCalls.length > 0) return;

    // SWD Mutation Bypass — never cache responses attempting to write files
    if (response.text.includes('[FILE_ACTION:')) return;

    try {
      const db = this.ensureDb();
      const serialized = JSON.stringify(response);

      db.prepare(
        'INSERT OR REPLACE INTO cache_entries (key, response, model, created_at, hit_count) VALUES (?, ?, ?, ?, 0)'
      ).run(key, serialized, model, Date.now());
    } catch {
      // Fail silently — caching is non-critical
    }
  }

  // ── Evict expired entries ────────────────────────────────
  evictExpired(): number {
    if (!this.enabled) return 0;

    try {
      const db = this.ensureDb();
      const cutoff = Date.now() - this.ttlMs;
      const result = db.prepare('DELETE FROM cache_entries WHERE created_at <= ?').run(cutoff);
      return (result as { changes: number }).changes ?? 0;
    } catch {
      return 0;
    }
  }

  // ── Clear entire cache ───────────────────────────────────
  clear(): void {
    if (!this.enabled) return;

    try {
      const db = this.ensureDb();
      db.prepare('DELETE FROM cache_entries').run();
    } catch {
      // Fail silently
    }
  }

  // ── Stats ────────────────────────────────────────────────
  stats(): { entries: number; totalHits: number; oldestMs: number } {
    if (!this.enabled) return { entries: 0, totalHits: 0, oldestMs: 0 };

    try {
      const db = this.ensureDb();
      const countRow = db.prepare('SELECT COUNT(*) as cnt FROM cache_entries').get() as { cnt: number };
      const hitsRow = db.prepare('SELECT COALESCE(SUM(hit_count), 0) as total FROM cache_entries').get() as { total: number };
      const oldestRow = db.prepare('SELECT MIN(created_at) as oldest FROM cache_entries').get() as { oldest: number | null };

      return {
        entries: countRow.cnt,
        totalHits: hitsRow.total,
        oldestMs: oldestRow.oldest ? Date.now() - oldestRow.oldest : 0,
      };
    } catch {
      return { entries: 0, totalHits: 0, oldestMs: 0 };
    }
  }

  // ── Close ────────────────────────────────────────────────
  close(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }
}
