// ─────────────────────────────────────────────────────────────
//  mythos-router :: index.ts
//  Public API / SDK Exports
// ─────────────────────────────────────────────────────────────

// Export the Anthropic Adaptive Routing Client
export { getClient, streamMessage, sendMessage, formatTokenUsage, type Message, type MythosResponse } from './client.js';

// Export the Strict Write Discipline Engine (v1 API)
export {
  SWDEngine,
  parseActions,
  snapshotFile,
  resolveSafePath,
  summarizeActions,
  printSWDResults,
  dryRunSWD,
  type FileAction,
  type ActionIntent,
  type ActionResult,
  type VerificationStatus,
  type SWDRunResult,
  type SWDOptions,
  type FileSnapshot,
} from './swd.js';

// Export the Self-Healing Memory
export { readMemory, writeCompressedMemory, initMemory, appendEntry, needsDream, getMemoryContext, type MemoryEntry } from './memory.js';

// Export the Budget Limiter
export { SessionBudget, type BudgetConfig, type BudgetCheck, type BudgetSnapshot } from './budget.js';

// Export Core Config & Models
export { MODELS, CAPYBARA_SYSTEM_PROMPT, getEffort, validateApiKey, type EffortLevel } from './config.js';

// Export the Chat UI Interface (for custom frontends)
export { type ChatUI } from './commands/chat.js';
