import { c } from './utils.js';

export interface DiffLine {
  op: 'add' | 'remove' | 'keep';
  val: string;
}

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


export function renderDiff(oldText: string, newText: string): string {
  if (oldText === newText) {
    return `  ${c.dim}(No changes detected)${c.reset}`;
  }

  const aLines = oldText.split('\n');
  const bLines = newText.split('\n');
  const diff = myersDiff(aLines, bLines);

  let output = '';
  let lineA = 1;
  let lineB = 1;

  for (const item of diff) {
    switch (item.op) {
      case 'keep':
        output += `  ${c.gray}${lineA.toString().padStart(3)} |   ${item.val}${c.reset}\n`;
        lineA++;
        lineB++;
        break;
      case 'add':
        output += `  ${c.gray}    | ${c.green}+ ${c.bold}${item.val}${c.reset}\n`;
        lineB++;
        break;
      case 'remove':
        output += `  ${c.gray}${lineA.toString().padStart(3)} | ${c.red}- ${c.bold}${item.val}${c.reset}\n`;
        lineA++;
        break;
    }
  }

  return output.trimEnd();
}
