// ─────────────────────────────────────────────────────────────
//  mythos-router :: index.ts
//  Public API / SDK Exports
// ─────────────────────────────────────────────────────────────

// Export the Backward-Compatible Client Facade
export { getClient, getOrchestrator, streamMessage, sendMessage, formatTokenUsage, type Message, type MythosResponse } from './client.js';

// Export the Provider Orchestration Engine
export { ProviderOrchestrator } from './providers/orchestrator.js';
export { AnthropicProvider } from './providers/anthropic.js';
export { calculateCost, getModelPricing, hasKnownPricing } from './providers/pricing.js';
export {
  type BaseProvider,
  type UnifiedChunk,
  type UnifiedResponse,
  type UnifiedToolCall,
  type RequestOptions,
  type StreamOptions,
  type SendOptions,
  type ProviderConfig,
  type ProviderCapability,
  type ProviderStatus,
  type OrchestrationEvent,
} from './providers/types.js';

// Export the Strict Write Discipline Engine (v1 API — Pure Kernel)
export {
  SWDEngine,
  parseActions,
  snapshotFile,
  resolveSafePath,
  summarizeActions,
  type FileAction,
  type ActionIntent,
  type ActionResult,
  type VerificationStatus,
  type SWDRunResult,
  type SWDOptions,
  type FileSnapshot,
} from './swd.js';

// Export the SWD CLI Presentation Layer
export { printSWDResults, dryRunSWD, printVerboseParse } from './swd-cli.js';

// Export the Self-Healing Memory
export { readMemory, writeCompressedMemory, initMemory, appendEntry, needsDream, getMemoryContext, type MemoryEntry } from './memory.js';

// Export the Deterministic Cache
export { ResponseCache, generateCacheKey, type CacheKeyInput } from './cache.js';

// Export the Budget Limiter
export { SessionBudget, type BudgetConfig, type BudgetCheck, type BudgetSnapshot } from './budget.js';

// Export Core Config & Models
export { MODELS, CAPYBARA_SYSTEM_PROMPT, getEffort, validateApiKey, type EffortLevel } from './config.js';

// Export the Chat UI Interface (for custom frontends)
export { type ChatUI } from './commands/chat.js';
