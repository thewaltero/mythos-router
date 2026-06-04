// ─────────────────────────────────────────────────────────────
//  mythos-router :: config.ts
//  Constants, system prompt, validation, and provider config
// ─────────────────────────────────────────────────────────────

// Anthropic model tiers. Defaults can be overridden per-tier via env vars,
// mirroring MYTHOS_OPENAI_MODEL / MYTHOS_DEEPSEEK_MODEL. This lets users pin an
// older version (e.g. MYTHOS_ANTHROPIC_MODEL_HIGH=claude-opus-4-7) without code changes.
export const MODELS: Record<string, string> = {
  high: process.env.MYTHOS_ANTHROPIC_MODEL_HIGH?.trim() || 'claude-opus-4-8',
  medium: process.env.MYTHOS_ANTHROPIC_MODEL_MEDIUM?.trim() || 'claude-sonnet-4-6',
  low: process.env.MYTHOS_ANTHROPIC_MODEL_LOW?.trim() || 'claude-haiku-4-5-20251001',
};

export const MAX_CORRECTION_RETRIES = 2;

export const MEMORY_FILE = 'MEMORY.md';
export const MEMORY_DB_FILE = 'memory.db';
export const MEMORY_MAX_LINES = 100;

export const MYTHOSIGNORE_FILE = '.mythosignore';
export const PROJECT_POLICY_FILE = '.mythos/policy.json';

// ── Budget Defaults (Financial Safety) ───────────────────────
export const DEFAULT_MAX_TOKENS_PER_SESSION = 500_000;
export const DEFAULT_MAX_TURNS = 25;
export const BUDGET_WARN_PERCENT = 80;

// ── Model Output Token Limits ────────────────────────────────
export const MAX_OUTPUT_TOKENS_STREAM = 16384;
export const MAX_OUTPUT_TOKENS_SEND = 8192;

// ── Anthropic Pricing (USD per token) ────────────────────────
// Claude Opus 4.8 pricing as of 2026-05. Verified unchanged from Opus 4.7:
// $5.00 / 1M input, $25.00 / 1M output. Update these when Anthropic changes rates.
// Note: when the provider API does not return token usage, budget/cost figures
// fall back to a rough characters/4 estimate — a guardrail, not exact billing.
// Source: https://www.anthropic.com/claude/opus
export const COST_PER_INPUT_TOKEN = 5 / 1_000_000; // $5.00 / 1M input tokens
export const COST_PER_OUTPUT_TOKEN = 25 / 1_000_000; // $25.00 / 1M output tokens

export const DEFAULT_IGNORE_PATTERNS = Object.freeze([
  'node_modules',
  '.git',
  'dist',
  'build',
  '.next',
  'coverage',
  '*.lock',
  'package-lock.json',
  'MEMORY.md',
]);

// ── The Leaked "Capybara" System Prompt ──────────────────────
export const CAPYBARA_SYSTEM_PROMPT = `\
## IDENTITY
Tier: Capybara (Mythos Router — Specialized in Cybersecurity & PhD Reasoning)
Model: Claude Opus 4.8 | Protocol: Strict Write Discipline
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
INTENT: MUTATE | NOOP | UNKNOWN
DESCRIPTION: <one-line description of what changed>
CONTENT: <full text of the new/modified file, if applicable>
[/FILE_ACTION]
\`\`\`

Do NOT include a content hash. Strict Write Discipline computes the SHA-256 of
the written file itself and verifies it against the CONTENT you provide — you are
never asked to compute or declare a hash, and you must not guess one.

#### Intent Grounding:
- **MUTATE**: You intend to change the file. Verification fails if no change occurs.
- **NOOP**: Idempotent action. Verification passes if the file remains identical.
- **UNKNOWN**: Intent is ambiguous or depends on current state. Optimistic success if no change.

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

const VALID_EFFORTS = new Set(['high', 'h', 'medium', 'med', 'm', 'low', 'l']);

export function getEffort(flag?: string): EffortLevel {
  if (flag === 'low' || flag === 'l') return 'low';
  if (flag === 'medium' || flag === 'med' || flag === 'm') return 'medium';
  if (flag && !VALID_EFFORTS.has(flag)) {
    console.warn(
      `\x1b[93m⚠ Unknown effort level "${flag}". Valid: high, medium, low. Defaulting to high.\x1b[0m`,
    );
  }
  return 'high'; // default: full capybara mode
}

// ── Validation ───────────────────────────────────────────────
export function getAnthropicKey(): string | null {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key || typeof key !== 'string' || key.trim().length === 0) return null;

  const trimmed = key.trim();
  if (!trimmed.startsWith('sk-ant-')) {
    throw new Error(
      'Invalid ANTHROPIC_API_KEY format. Expected prefix: sk-ant-...\n'
    );
  }

  return trimmed;
}

export function validateApiKey(): string {
  const key = getAnthropicKey();
  if (!key) {
    throw new Error(
      'ANTHROPIC_API_KEY not set.\n' +
      '  Set it:  export ANTHROPIC_API_KEY="sk-ant-..."\n' +
      '  Or:      $env:ANTHROPIC_API_KEY = "sk-ant-..."\n'
    );
  }

  return key;
}

// ── Multi-Provider API Key Helpers ───────────────────────────
export function getOpenAIKey(): string | null {
  const key = process.env.OPENAI_API_KEY;
  if (!key || typeof key !== 'string' || key.trim().length === 0) return null;
  return key.trim();
}

export function getDeepSeekKey(): string | null {
  const key = process.env.DEEPSEEK_API_KEY;
  if (!key || typeof key !== 'string' || key.trim().length === 0) return null;
  return key.trim();
}

export function getSurplusKey(): string | null {
  const key = process.env.SURPLUS_API_KEY;
  if (!key || typeof key !== 'string' || key.trim().length === 0) return null;
  return key.trim();
}

/** Detect which provider API keys are configured */
export interface AvailableProviders {
  anthropic: string | null;
  openai: string | null;
  deepseek: string | null;
  surplus: string | null;
}

export function detectProviders(): AvailableProviders {
  return {
    // Detection is intentionally non-throwing for init/status UIs.
    // Runtime validation still happens in validateProviderKeys().
    anthropic: process.env.ANTHROPIC_API_KEY?.trim() || null,
    openai: getOpenAIKey(),
    deepseek: getDeepSeekKey(),
    surplus: getSurplusKey(),
  };
}

export function validateProviderKeys(): AvailableProviders {
  const providers: AvailableProviders = {
    anthropic: getAnthropicKey(),
    openai: getOpenAIKey(),
    deepseek: getDeepSeekKey(),
    surplus: getSurplusKey(),
  };
  if (!providers.anthropic && !providers.openai && !providers.deepseek && !providers.surplus) {
    throw new Error(
      'No model provider API key set. Configure at least one provider for mythos chat/run:\n' +
      '  ANTHROPIC_API_KEY="sk-ant-..."     # Claude / recommended default\n' +
      '  OPENAI_API_KEY="sk-..."            # OpenAI-compatible fallback\n' +
      '  DEEPSEEK_API_KEY="..."             # DeepSeek fallback\n' +
      '  SURPLUS_API_KEY="inf_..."          # Surplus marketplace (discounted, OpenAI-compatible)\n' +
      'Note: mythos swd apply does not require any model API key.'
    );
  }
  return providers;
}
