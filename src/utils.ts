// ─────────────────────────────────────────────────────────────
//  mythos-router :: utils.ts
//  Terminal colors, spinners, and formatting
// ─────────────────────────────────────────────────────────────

// ── ANSI Colors (zero-dep) ───────────────────────────────────
export const c = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  italic: '\x1b[3m',
  underline: '\x1b[4m',

  // Foreground
  black: '\x1b[30m',
  red: '\x1b[91m',
  green: '\x1b[92m',
  yellow: '\x1b[93m',
  blue: '\x1b[94m',
  magenta: '\x1b[95m',
  cyan: '\x1b[96m',
  white: '\x1b[97m',
  gray: '\x1b[90m',

  // Background
  bgRed: '\x1b[41m',
  bgGreen: '\x1b[42m',
  bgYellow: '\x1b[43m',
  bgBlue: '\x1b[44m',
  bgMagenta: '\x1b[45m',
  bgCyan: '\x1b[46m',
};

// ── Semantic Theme ───────────────────────────────────────────
export const theme = {
  success: c.green,   // ✔ verified, passed, created
  warning: c.yellow,  // ⚠ dry-run, warning, budget alert
  error:   c.red,     // ✖ failed, rollback, missing
  info:    c.cyan,    // ℹ provider, model, metadata values
  muted:   c.dim,     // timestamps, labels, secondary text
  accent:  c.magenta, // prompt, branding
};

export const icon = {
  success:  '✔',
  warning:  '⚠',
  error:    '✖',
  info:     'ℹ',
  thinking: '◌',
  action:   '▸',
  rollback: '⟲',
  budget:   '◈',
  memory:   '◉',
  branch:   '⎇',
};

// ── Banner ───────────────────────────────────────────────────
export const BANNER = `
${c.cyan}${c.bold}    ███╗   ███╗██╗   ██╗████████╗██╗  ██╗ ██████╗ ███████╗
    ████╗ ████║╚██╗ ██╔╝╚══██╔══╝██║  ██║██╔═══██╗██╔════╝
    ██╔████╔██║ ╚████╔╝    ██║   ███████║██║   ██║███████╗
    ██║╚██╔╝██║  ╚██╔╝     ██║   ██╔══██║██║   ██║╚════██║
    ██║ ╚═╝ ██║   ██║      ██║   ██║  ██║╚██████╔╝███████║
    ╚═╝     ╚═╝   ╚═╝      ╚═╝   ╚═╝  ╚═╝ ╚═════╝ ╚══════╝${c.reset}

${c.dim}    AI code router with memory, dry-run safety, and SWD verification${c.reset}
`;

// ── Spinner ──────────────────────────────────────────────────
const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

export class Spinner {
  private interval: ReturnType<typeof setInterval> | null = null;
  private frameIdx = 0;
  private currentMessage = '';

  start(message: string) {
    this.currentMessage = message;
    this.frameIdx = 0;
    process.stdout.write('\x1b[?25l'); // hide cursor
    
    // Render first frame immediately
    const frame = SPINNER_FRAMES[0]!;
    process.stdout.write(
      `\r\x1b[K${c.cyan}${frame}${c.reset} ${c.dim}${this.currentMessage}${c.reset}`
    );

    this.interval = setInterval(() => {
      const frame = SPINNER_FRAMES[this.frameIdx % SPINNER_FRAMES.length]!;
      process.stdout.write(
        `\r\x1b[K${c.cyan}${frame}${c.reset} ${c.dim}${this.currentMessage}${c.reset}`
      );
      this.frameIdx++;
    }, 80);
  }

  update(message: string) {
    this.currentMessage = message;
    // Force an immediate render so it feels responsive
    const frame = SPINNER_FRAMES[this.frameIdx % SPINNER_FRAMES.length]!;
    process.stdout.write(
      `\r\x1b[K${c.cyan}${frame}${c.reset} ${c.dim}${this.currentMessage}${c.reset}`
    );
  }

  stop(finalMessage?: string) {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    process.stdout.write('\r\x1b[K'); // clear line
    process.stdout.write('\x1b[?25h'); // show cursor
    if (finalMessage) {
      console.log(finalMessage);
    }
  }
}

// ── Formatting helpers ───────────────────────────────────────
export function timestamp(): string {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

export function hr(char = '─', len = 60): string {
  return `${c.dim}${char.repeat(len)}${c.reset}`;
}

export function heading(text: string): string {
  return `\n${c.bold}${c.cyan}▸ ${text}${c.reset}\n${hr()}`;
}

export function success(text: string): void {
  console.log(`${c.green}✔${c.reset} ${text}`);
}

export function warn(text: string): void {
  console.log(`${c.yellow}⚠${c.reset} ${text}`);
}

export function error(text: string): void {
  console.log(`${c.red}✖${c.reset} ${text}`);
}

export function info(text: string): void {
  console.log(`${c.blue}ℹ${c.reset} ${text}`);
}

export function thinking(text: string): void {
  console.log(`${c.dim}${c.italic}💭 ${text}${c.reset}`);
}

// ── Badges ───────────────────────────────────────────────────
export function modeBadge(label: string, bgColor: string, fgColor = c.black): string {
  return `${bgColor}${fgColor}${c.bold} ${label} ${c.reset}`;
}

export function dryRunBadge(): string {
  return modeBadge('DRY-RUN', c.bgYellow);
}

export function verboseBadge(): string {
  return modeBadge('VERBOSE', c.bgBlue, c.white);
}

export function branchBadge(name: string): string {
  return modeBadge(`BRANCH: ${name}`, c.bgCyan);
}

export function resumeBadge(): string {
  return modeBadge('RESUME', c.bgMagenta, c.white);
}

export function noBudgetBadge(): string {
  return modeBadge('NO-BUDGET', c.bgRed, c.white);
}

export interface BadgeRowConfig {
  dryRun?: boolean;
  verbose?: boolean;
  branch?: string;
  resume?: boolean;
  noBudget?: boolean;
}

export function renderBadgeRow(config: BadgeRowConfig): string {
  const badges: string[] = [];
  if (config.dryRun)   badges.push(dryRunBadge());
  if (config.branch)   badges.push(branchBadge(config.branch));
  if (config.noBudget) badges.push(noBudgetBadge());
  if (config.resume)   badges.push(resumeBadge());
  if (config.verbose)  badges.push(verboseBadge());
  if (badges.length === 0) return '';
  return '  ' + badges.join(' ') + '\n';
}

// ── Progress Bar ─────────────────────────────────────────────
export function progressBar(percent: number, width = 20): string {
  const clamped = Math.max(0, Math.min(100, percent));
  const filled = Math.round((clamped / 100) * width);
  const empty = width - filled;
  return `[${'█'.repeat(filled)}${'░'.repeat(empty)}]`;
}

// ── ANSI-Safe Width Helpers ──────────────────────────────────
export function stripAnsi(str: string): string {
  return str.replace(/\x1b\[[0-9;]*m/g, '');
}

function visualWidth(str: string): number {
  return stripAnsi(str).length;
}

function padEnd(str: string, targetWidth: number): string {
  const gap = targetWidth - visualWidth(str);
  return gap > 0 ? str + ' '.repeat(gap) : str;
}

// ── Box Renderer ─────────────────────────────────────────────
// Pure rendering — takes data in, returns string out.
export function renderBox(title: string, rows: [string, string][], width = 58): string {
  const inner = width - 2; // │  ...  │
  const lines: string[] = [];

  // Top border: ┌─ Title ──...──┐
  const titleStr = ` ${title} `;
  const topFill = width - 3 - titleStr.length; // minus ┌, ─ and ┐
  lines.push(`${c.dim}┌─${c.reset}${c.bold}${titleStr}${c.reset}${c.dim}${'─'.repeat(Math.max(0, topFill))}┐${c.reset}`);

  // Rows: │  Label   Value  ...  │
  for (const [label, value] of rows) {
    const labelStr = `${c.dim}${label}${c.reset}`;
    const labelWidth = 11; // fixed label column
    const paddedLabel = padEnd(labelStr, labelWidth);
    const content = `  ${paddedLabel}${value}`;
    const padded = padEnd(content, inner);
    lines.push(`${c.dim}│${c.reset}${padded}${c.dim}│${c.reset}`);
  }

  // Bottom border: └──...──┘
  lines.push(`${c.dim}└${'─'.repeat(width - 2)}┘${c.reset}`);

  return lines.join('\n');
}

// ── Session Card ─────────────────────────────────────────────
// Pure rendering — caller provides all data, no I/O here.
export interface SessionCardConfig {
  provider: string;
  model: string;
  dryRun: boolean;
  budgetEnabled: boolean;
  branch: string;
  memoryEntries: number;
  memoryActive: boolean;
  tokensUsed: number;
  maxTokens: number;
  turnsUsed: number;
  maxTurns: number;
}

export function renderSessionCard(cfg: SessionCardConfig): string {
  const modeFragments: string[] = [];
  modeFragments.push(`dry-run: ${cfg.dryRun ? `${theme.warning}on${c.reset}` : `${theme.muted}off${c.reset}`}`);
  modeFragments.push(`budget: ${cfg.budgetEnabled ? `${theme.muted}on${c.reset}` : `${theme.warning}off${c.reset}`}`);

  const tokensLabel = cfg.maxTokens >= 1_000_000
    ? `${(cfg.maxTokens / 1_000_000).toFixed(1)}M`
    : `${Math.round(cfg.maxTokens / 1000)}k`;

  const memoryStatus = cfg.memoryActive
    ? `${theme.info}${cfg.memoryEntries}${c.reset} entries ${theme.muted}· status: ${theme.success}active${c.reset}`
    : `${theme.info}${cfg.memoryEntries}${c.reset} entries ${theme.muted}· status: ${theme.warning}pending${c.reset}`;

  const tokensUsedFormatted = cfg.tokensUsed >= 1_000_000
    ? `${(cfg.tokensUsed / 1_000_000).toFixed(1)}M`
    : cfg.tokensUsed >= 1_000 ? `${Math.round(cfg.tokensUsed / 1000)}k` : cfg.tokensUsed.toString();

  const rows: [string, string][] = [
    ['Provider', `${theme.info}${cfg.provider}${c.reset}`],
    ['Model', `${theme.info}${cfg.model}${c.reset}`],
    ['Mode', modeFragments.join(`${theme.muted} · ${c.reset}`)],
    ['Branch', `${theme.info}${cfg.branch}${c.reset}`],
    ['Memory', memoryStatus],
    ['Budget', `${theme.muted}${tokensUsedFormatted} / ${tokensLabel} tokens · ${cfg.turnsUsed} / ${cfg.maxTurns} turns${c.reset}`],
  ];

  return renderBox('Session', rows);
}

// ── Help Screen ──────────────────────────────────────────────
// Pure rendering — no side effects.
export function renderHelpScreen(): string {
  const rows: [string, string][] = [
    ['/help', `${theme.muted}Show this screen${c.reset}`],
    ['/status', `${theme.muted}Session status card${c.reset}`],
    ['/budget', `${theme.muted}Budget details${c.reset}`],
    ['/memory', `${theme.muted}Memory stats${c.reset}`],
    ['/clear', `${theme.muted}Clear conversation history${c.reset}`],
    ['exit | /q', `${theme.muted}Save progress and exit${c.reset}`],
    ['', ''],
    ['Ctrl+C', `${theme.muted}Graceful save and exit${c.reset}`],
  ];

  return renderBox('Commands', rows);
}

// ── Exit Summary ─────────────────────────────────────────────
// Pure rendering — caller provides all data.
export interface ExitSummaryConfig {
  duration: string;
  turns: number;
  maxTurns: number;
  tokens: number;
  maxTokens: number;
  cost: number;
  memoryEntriesAdded: number;
  saved: boolean;
}

export function renderExitSummary(cfg: ExitSummaryConfig): string {
  const tokensLabel = cfg.maxTokens >= 1_000_000
    ? `${(cfg.maxTokens / 1_000_000).toFixed(1)}M`
    : `${Math.round(cfg.maxTokens / 1000)}k`;

  const savedStatus = cfg.saved
    ? `${theme.success}${icon.success} saved${c.reset}`
    : `${theme.warning}${icon.warning} not saved${c.reset}`;

  const rows: [string, string][] = [
    ['Duration', `${theme.info}${cfg.duration}${c.reset}`],
    ['Turns', `${theme.info}${cfg.turns}${c.reset}${theme.muted} / ${cfg.maxTurns}${c.reset}`],
    ['Tokens', `${theme.info}${cfg.tokens.toLocaleString()}${c.reset}${theme.muted} / ${tokensLabel}${c.reset}`],
    ['Cost', `${theme.info}~$${cfg.cost.toFixed(4)}${c.reset}`],
    ['Memory', `${theme.info}+${cfg.memoryEntriesAdded}${c.reset}${theme.muted} entries → MEMORY.md${c.reset}`],
    ['Status', savedStatus],
  ];

  return renderBox('Session Complete', rows);
}

// ── Interactive Y/n Confirm Prompt ───────────────────────────
import * as readline from 'node:readline';

export function confirmPrompt(message: string, defaultValue = true): Promise<boolean> {
  return new Promise((resolve) => {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      resolve(defaultValue);
      return;
    }

    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    const suffix = defaultValue ? '[Y/n]' : '[y/N]';
    rl.question(`${message} ${c.dim}${suffix}${c.reset} `, (answer) => {
      rl.close();
      const trimmed = answer.trim().toLowerCase();
      if (trimmed === '') {
        resolve(defaultValue);
        return;
      }
      resolve(trimmed === 'y' || trimmed === 'yes');
    });
  });
}

// ── Test Runner ──────────────────────────────────────────────
import { spawn } from 'node:child_process';

export interface TestResult {
  passed: boolean;
  output: string;
}

export function runTestCommand(cmd: string, timeoutMs = 15000, cwd: string = process.cwd()): Promise<TestResult> {
  return new Promise((resolve) => {
    let finished = false;
    
    const safeResolve = (result: TestResult) => {
      if (finished) return;
      finished = true;
      resolve(result);
    };

    const child = spawn(cmd, { shell: true, cwd });
    let output = '';
    
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      safeResolve({ passed: false, output: `[TIMEOUT] Test exceeded ${timeoutMs}ms and was killed.` });
    }, timeoutMs);

    child.stdout.on('data', (data) => output += data.toString());
    child.stderr.on('data', (data) => output += data.toString());

    child.on('error', (err) => {
      clearTimeout(timer);
      safeResolve({ passed: false, output: `Test runner crashed: ${err.message}` });
    });

    child.on('close', (code) => {
      clearTimeout(timer);

      if (!output.trim()) {
        output = 'No output provided. The test command may not produce logs.';
      }

      const maxLen = 2000;
      let finalOutput = output;
      
      if (output.length > maxLen) {
        const head = output.slice(0, 500);
        const tail = output.slice(-1500);
        finalOutput = `${head}\n\n...[TRUNCATED]...\n\n${tail}`;
      }

      safeResolve({ passed: code === 0, output: finalOutput });
    });
  });
}
