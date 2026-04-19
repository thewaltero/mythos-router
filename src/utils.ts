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

// ── Banner ───────────────────────────────────────────────────
export const BANNER = `
${c.cyan}${c.bold}
    ███╗   ███╗██╗   ██╗████████╗██╗  ██╗ ██████╗ ███████╗
    ████╗ ████║╚██╗ ██╔╝╚══██╔══╝██║  ██║██╔═══██╗██╔════╝
    ██╔████╔██║ ╚████╔╝    ██║   ███████║██║   ██║███████╗
    ██║╚██╔╝██║  ╚██╔╝     ██║   ██╔══██║██║   ██║╚════██║
    ██║ ╚═╝ ██║   ██║      ██║   ██║  ██║╚██████╔╝███████║
    ╚═╝     ╚═╝   ╚═╝      ╚═╝   ╚═╝  ╚═╝ ╚═════╝ ╚══════╝
${c.reset}${c.dim}    ┌─────────────────────────────────────────────────────┐
    │  ${c.yellow}Capybara Tier${c.reset}${c.dim} · Opus 4.7 · Strict Write Discipline  │
    │  ${c.gray}Adaptive Thinking · Self-Healing Memory · Zero Slop${c.reset}${c.dim}  │
    └─────────────────────────────────────────────────────┘${c.reset}
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

// ── Dry-Run / Verbose Badges ─────────────────────────────────
export function dryRunBadge(): string {
  return `${c.bgYellow}${c.black}${c.bold} DRY-RUN ${c.reset}`;
}

export function verboseBadge(): string {
  return `${c.bgBlue}${c.white}${c.bold} VERBOSE ${c.reset}`;
}

// ── Progress Bar ─────────────────────────────────────────────
export function progressBar(percent: number, width = 20): string {
  const clamped = Math.max(0, Math.min(100, percent));
  const filled = Math.round((clamped / 100) * width);
  const empty = width - filled;
  return `[${'█'.repeat(filled)}${'░'.repeat(empty)}]`;
}

// ── Interactive Y/n Confirm Prompt ───────────────────────────
import * as readline from 'node:readline';

export function confirmPrompt(message: string): Promise<boolean> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    rl.question(`${message} ${c.dim}[Y/n]${c.reset} `, (answer) => {
      rl.close();
      const trimmed = answer.trim().toLowerCase();
      resolve(trimmed === '' || trimmed === 'y' || trimmed === 'yes');
    });
  });
}
