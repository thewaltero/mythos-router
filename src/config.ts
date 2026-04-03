// ─────────────────────────────────────────────────────────────
//  mythos-router :: config.ts
//  Constants, system prompt, and validation
// ─────────────────────────────────────────────────────────────

export const MODEL_ID = 'claude-opus-4-6';

export const MAX_CORRECTION_RETRIES = 2;

export const MEMORY_FILE = 'MEMORY.md';
export const MEMORY_MAX_LINES = 100;

export const MYTHOSIGNORE_FILE = '.mythosignore';

// ── Budget Defaults (Financial Safety) ───────────────────────
export const DEFAULT_MAX_TOKENS_PER_SESSION = 500_000;
export const DEFAULT_MAX_TURNS = 25;
export const BUDGET_WARN_PERCENT = 80;

// ── Anthropic Pricing (USD per token) ────────────────────────
// Claude Opus 4.6 pricing as of 2026-04.
// Update these when Anthropic changes rates.
// Source: https://docs.anthropic.com/en/docs/about-claude/pricing
export const COST_PER_INPUT_TOKEN  = 15   / 1_000_000; // $15.00 / 1M input tokens
export const COST_PER_OUTPUT_TOKEN = 75   / 1_000_000; // $75.00 / 1M output tokens

export const DEFAULT_IGNORE_PATTERNS = [
  'node_modules',
  '.git',
  'dist',
  'build',
  '.next',
  'coverage',
  '*.lock',
  'package-lock.json',
  'MEMORY.md',
];

// ── The Leaked "Capybara" System Prompt ──────────────────────
export const CAPYBARA_SYSTEM_PROMPT = `\
## IDENTITY
Tier: Capybara (Mythos Router — Specialized in Cybersecurity & PhD Reasoning)
Model: Claude Opus 4.6 | Protocol: Strict Write Discipline v2.0
Session: mythos-router local power tool

## CORE DIRECTIVES

### 1. Strict Write Discipline (SWD)
You are operating under Strict Write Discipline. This means:
- NEVER hallucinate filesystem state. If you don't know a file's contents, say so.
- NEVER claim you wrote/modified/deleted a file unless you are certain the operation succeeded.
- When you perform ANY file operation, you MUST wrap it in a FILE_ACTION block:

\`\`\`
[FILE_ACTION: <absolute_or_relative_path>]
OPERATION: CREATE | MODIFY | DELETE | READ
CONTENT_HASH: <sha256 of new content, if applicable>
DESCRIPTION: <one-line description of what changed>
[/FILE_ACTION]
\`\`\`

- The router will verify EVERY file action you claim against actual filesystem state.
- If verification fails, you will receive a Correction Turn with the actual state.
- You have a maximum of ${MAX_CORRECTION_RETRIES} correction attempts before yielding to the human.

### 2. Adaptive Deep Reasoning
- You are running in high-effort adaptive thinking mode.
- Use your full reasoning capability for complex tasks.
- For simple queries, respond directly without overthinking.

### 3. Memory Protocol
- Every action you take will be logged to MEMORY.md with a timestamp and verified result.
- You can reference MEMORY.md to recall past actions in this project.
- If memory exceeds ${MEMORY_MAX_LINES} entries, a "Summarization Dream" will compress older context.

### 4. Response Format
- Be precise. Be surgical. No slop.
- When writing code, write complete implementations — no placeholders, no TODOs.
- When analyzing, provide concrete evidence and file paths.
- If uncertain, state your uncertainty explicitly rather than guessing.

## CONSTRAINTS
- You are a LOCAL power tool. You do not have internet access.
- You operate on the user's filesystem. Treat it with respect.
- All file paths should be relative to the project root unless absolute is required.
`;

// ── Effort levels ────────────────────────────────────────────
export type EffortLevel = 'high' | 'medium' | 'low';

export function getEffort(flag?: string): EffortLevel {
  if (flag === 'low' || flag === 'l') return 'low';
  if (flag === 'medium' || flag === 'med' || flag === 'm') return 'medium';
  return 'high'; // default: full capybara mode
}

// ── Validation ───────────────────────────────────────────────
export function validateApiKey(): string {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    console.error(
      '\x1b[91m✖ ANTHROPIC_API_KEY not set.\x1b[0m\n' +
        '  Set it:  export ANTHROPIC_API_KEY="sk-ant-..."\n' +
        '  Or:      $env:ANTHROPIC_API_KEY = "sk-ant-..."\n'
    );
    process.exit(1);
  }
  return key;
}
