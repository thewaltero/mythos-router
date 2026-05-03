// ─────────────────────────────────────────────────────────────
//  mythos-router :: diff.ts
//  Minimal Myers' Diff Algorithm (Shortest Edit Script)
//  Line-by-line comparison with professional ANSI rendering
// ─────────────────────────────────────────────────────────────

import { c, theme } from './utils.js';

export interface DiffLine {
  op: 'add' | 'remove' | 'keep';
  val: string;
}

/**
 * Shortest Edit Script (SES) using Myers' algorithm.
 * O((N+M)D) time and space complexity.
 */
export function myersDiff(a: string[], b: string[]): DiffLine[] {
  const n = a.length;
  const m = b.length;
  const v: number[] = new Array(2 * (n + m) + 1);
  const trace: number[][] = [];

  v[1 + (n + m)] = 0; // Base case for Myers algorithm

  for (let d = 0; d <= n + m; d++) {
    const currentV = [...v];
    trace.push(currentV);

    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (k === -d || (k !== d && v[k - 1 + (n + m)] < v[k + 1 + (n + m)])) {
        x = v[k + 1 + (n + m)];
      } else {
        x = v[k - 1 + (n + m)] + 1;
      }

      let y = x - k;

      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }

      v[k + (n + m)] = x;

      if (x >= n && y >= m) return backtrack(trace, a, b);
    }
  }
  return [];
}

function backtrack(trace: number[][], a: string[], b: string[]): DiffLine[] {
  const diff: DiffLine[] = [];
  let x = a.length;
  let y = b.length;

  for (let d = trace.length - 1; d >= 0; d--) {
    const v = trace[d]!;
    const k = x - y;

    let prevK: number;
    if (k === -d || (k !== d && v[k - 1 + (a.length + b.length)] < v[k + 1 + (a.length + b.length)])) {
      prevK = k + 1;
    } else {
      prevK = k - 1;
    }

    const prevX = v[prevK + (a.length + b.length)]!;
    const prevY = prevX - prevK;

    while (x > prevX && y > prevY) {
      diff.unshift({ op: 'keep', val: a[x - 1]! });
      x--;
      y--;
    }

    if (d > 0) {
      if (x > prevX) diff.unshift({ op: 'remove', val: a[x - 1]! });
      else if (y > prevY) diff.unshift({ op: 'add', val: b[y - 1]! });
    }
    x = prevX;
    y = prevY;
  }
  return diff;
}

/**
 * Renders a professional ANSI diff between two strings.
 * Shows contextLines lines of context around changes,
 * collapses large unchanged blocks with a separator.
 */
export function renderDiff(oldText: string, newText: string, contextLines = 3): string {
  if (oldText === newText) {
    return `  ${theme.muted}(No changes detected)${c.reset}`;
  }

  const aLines = oldText.split('\n');
  const bLines = newText.split('\n');
  const diff = myersDiff(aLines, bLines);

  // Find which diff indices are changes (add/remove)
  const changeIndices = new Set<number>();
  for (let i = 0; i < diff.length; i++) {
    if (diff[i]!.op !== 'keep') changeIndices.add(i);
  }

  // Compute visible set: change lines + contextLines around them
  const visible = new Set<number>();
  for (const idx of changeIndices) {
    for (let j = Math.max(0, idx - contextLines); j <= Math.min(diff.length - 1, idx + contextLines); j++) {
      visible.add(j);
    }
  }

  let output = '';
  let lineA = 1;
  let lineB = 1;
  let lastPrinted = -1;
  let additions = 0;
  let deletions = 0;

  for (let i = 0; i < diff.length; i++) {
    const item = diff[i]!;

    if (!visible.has(i)) {
      // Track line numbers for skipped lines
      if (item.op === 'keep') { lineA++; lineB++; }
      else if (item.op === 'add') { lineB++; additions++; }
      else if (item.op === 'remove') { lineA++; deletions++; }
      continue;
    }

    // Insert collapse separator when there's a gap
    if (lastPrinted >= 0 && i - lastPrinted > 1) {
      const skipped = i - lastPrinted - 1;
      output += `  ${theme.muted}     ... ${skipped} unchanged lines ...${c.reset}\n`;
    }
    lastPrinted = i;

    switch (item.op) {
      case 'keep':
        output += `  ${c.gray}${lineA.toString().padStart(3)} \u2502   ${item.val}${c.reset}\n`;
        lineA++;
        lineB++;
        break;
      case 'add':
        output += `  ${c.gray}    \u2502 ${theme.success}+ ${c.bold}${item.val}${c.reset}\n`;
        lineB++;
        additions++;
        break;
      case 'remove':
        output += `  ${c.gray}${lineA.toString().padStart(3)} \u2502 ${theme.error}- ${c.bold}${item.val}${c.reset}\n`;
        lineA++;
        deletions++;
        break;
    }
  }

  // Stats footer
  const statsFragments: string[] = [];
  if (additions > 0) statsFragments.push(`${theme.success}+${additions}${c.reset}`);
  if (deletions > 0) statsFragments.push(`${theme.error}-${deletions}${c.reset}`);
  if (statsFragments.length > 0) {
    output += `\n  ${theme.muted}${statsFragments.join(', ')}${c.reset}`;
  }

  return output.trimEnd();
}
