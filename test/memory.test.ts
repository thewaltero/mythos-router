import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, existsSync, unlinkSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import {
  initMemory,
  appendEntry,
  readMemory,
  getEntryCount,
  needsDream,
  writeCompressedMemory,
  getMemoryContext,
  getMemoryPath,
  getDbPath,
  searchMemory,
} from '../src/memory.js';


const memoryPath = getMemoryPath();
const dbPath = getDbPath();
let backup: string | null = null;

describe('Memory System', () => {
  beforeEach(() => {
    // Authority Setup
    if (existsSync(memoryPath)) {
      backup = readFileSync(memoryPath, 'utf-8');
      unlinkSync(memoryPath);
    }
    // Derivative Setup (Fresh start)
    if (existsSync(dbPath)) {
      // Small delay or retry might be needed if node:sqlite keeps it open
      try { unlinkSync(dbPath); } catch {}
    }
  });

  afterEach(() => {
    // Authority Restore
    if (backup !== null) {
      writeFileSync(memoryPath, backup, 'utf-8');
    } else if (existsSync(memoryPath)) {
      unlinkSync(memoryPath);
    }
    // Derivative cleanup
    if (existsSync(dbPath)) {
      try { unlinkSync(dbPath); } catch {}
    }
  });


  it('creates MEMORY.md and memory.db if they do not exist', () => {
    assert.equal(existsSync(memoryPath), false);
    assert.equal(existsSync(dbPath), false);
    initMemory();
    assert.equal(existsSync(memoryPath), true);
    assert.equal(existsSync(dbPath), true);
  });

  it('does not overwrite existing MEMORY.md', () => {
    writeFileSync(memoryPath, '# Custom Memory\n', 'utf-8');
    initMemory();
    const content = readFileSync(memoryPath, 'utf-8');
    assert.ok(content.includes('# Custom Memory'));
  });

  it('skips creation in dry-run mode', () => {
    initMemory(true); // dry-run
    assert.equal(existsSync(memoryPath), false);
  });


  it('appends and reads back entries', () => {
    initMemory();
    appendEntry('CREATE: src/test.ts', '✅ verified');
    appendEntry('MODIFY: src/config.ts', '✅ verified');

    const { entries } = readMemory();
    assert.equal(entries.length, 2);
    assert.ok(entries[0]!.action.includes('CREATE'));
    assert.ok(entries[1]!.action.includes('MODIFY'));
  });

  it('sanitizes pipes in entry content', () => {
    initMemory();
    appendEntry('test|with|pipes', 'result|here');

    const raw = readFileSync(memoryPath, 'utf-8');
    const dataLines = raw.split('\n').filter(
      (l) => l.startsWith('|') && !l.includes('---') && !l.includes('Timestamp'),
    );
    assert.equal(dataLines.length, 1);
    assert.ok(!dataLines[0]!.includes('test|with'));
  });

  it('skips append in dry-run mode', () => {
    initMemory();
    const before = readFileSync(memoryPath, 'utf-8');
    appendEntry('should-not-appear', 'dry-run', true);
    const after = readFileSync(memoryPath, 'utf-8');
    assert.equal(before, after);
  });


  it('returns 0 for fresh memory', () => {
    initMemory();
    assert.equal(getEntryCount(), 0);
  });

  it('returns correct count after appending', () => {
    initMemory();
    appendEntry('action1', 'result1');
    appendEntry('action2', 'result2');
    appendEntry('action3', 'result3');
    assert.equal(getEntryCount(), 3);
  });


  it('returns false when under threshold', () => {
    initMemory();
    appendEntry('test', 'test');
    assert.equal(needsDream(), false);
  });


  it('returns full content when under maxChars', () => {
    initMemory();
    appendEntry('short action', 'short result');
    const ctx = getMemoryContext(10_000);
    assert.ok(ctx.includes('short action'));
  });

  it('truncates content when over maxChars', () => {
    initMemory();
    for (let i = 0; i < 20; i++) {
      appendEntry(`action number ${i} with some extra text`, `result number ${i}`);
    }
    const ctx = getMemoryContext(200);
    assert.ok(ctx.includes('[truncated]'));
    assert.ok(ctx.length <= 220);
  });

  it('provides surgical search via FTS5 SQLite index', () => {
    initMemory();
    appendEntry('scaffold auth module', '✅ success');
    appendEntry('fix budget overflow', '✅ success');
    appendEntry('update system prompt', '✅ success');

    // Query 1: exact match
    const res1 = searchMemory('auth');
    assert.equal(res1.length, 1);
    assert.equal(res1[0]!.action, 'scaffold auth module');

    // Query 2: broader match
    const res2 = searchMemory('success');
    assert.equal(res2.length, 3);
  });

  it('writes compressed memory and triggers index rebuild', () => {
    initMemory();
    appendEntry('entry before dream', '✅');
    
    const recentEntries = [
      { timestamp: '2026-01-01 00:00:00', action: 'dreamaction', result: '✅' },
    ];
    writeCompressedMemory('dream summary here', recentEntries);

    // Verify Authority (MD)
    const content = readFileSync(memoryPath, 'utf-8');
    assert.ok(content.includes('dream summary here'));
    assert.ok(content.includes('dreamaction'));

    // Verify Entry Count (Authority check)
    assert.equal(getEntryCount(), 1);

    // Verify Derivative (DB) - Should have rebuilt to match the new reality
    const res = searchMemory('dreamaction');
    assert.equal(res.length, 1);
    assert.equal(res[0]!.action, 'dreamaction');
    
    // The old entry should be gone from the index
    const resOld = searchMemory('before');
    assert.equal(resOld.length, 0);
  });

  it('skips write in dry-run mode', () => {
    initMemory();
    const before = readFileSync(memoryPath, 'utf-8');
    writeCompressedMemory('summary', [], true);
    const after = readFileSync(memoryPath, 'utf-8');
    assert.equal(before, after);
  });
});
