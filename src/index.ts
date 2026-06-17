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
  type FileSnapshotSummary,
} from './swd.js';

// Export the SWD CLI Presentation Layer
export { printSWDResults, dryRunSWD, printVerboseParse } from './swd-cli.js';

// Export the Self-Healing Memory
export { readMemory, writeCompressedMemory, initMemory, appendEntry, needsDream, getMemoryContext, type MemoryEntry } from './memory.js';

// Export the Deterministic Cache
export { ResponseCache, generateCacheKey, type CacheKeyInput } from './cache.js';

// Export Skill Pack helpers
export {
  loadSkill,
  listSkills,
  validateSkill,
  validateSkills,
  parseSkillContent,
  checkSkills,
  createSkill,
  buildSkillPrompt,
  ensureSkillsDir,
  getProjectSkillsDir,
  getGlobalSkillsDir,
  getSkillsDir,
  type Skill,
  type SkillMeta,
  type SkillScope,
  type SkillValidation,
  type ParseSkillContentOptions,
  type SkillListEntry,
  type SkillCheckIssue,
  type SkillCheckResult,
  type CreateSkillOptions,
} from './skills.js';

// Export Repo Learning helpers
export {
  analyzeRepo,
  learnRepoSkill,
  type RepoLearningProfile,
  type LearnRepoSkillOptions,
  type LearnRepoSkillResult,
} from './learn.js';

// Export the Verified Cost-Router escalation policy
export {
  EFFORT_LADDER,
  DEFAULT_ESCALATION_CEILING,
  effortRank,
  nextEffort,
  effortForCorrection,
  isAtCeiling,
  parseEscalationConfig,
  type EscalationConfig,
  type EscalationOptionInput,
} from './escalation.js';

// Export Self-Improving Skills (receipt-derived skill learning)
export {
  analyzeReceiptsForSkill,
  classifyFailure,
  renderLearnedSkill,
  DEFAULT_LEARNED_SKILL_NAME,
  DEFAULT_MIN_OCCURRENCES,
  type LearnedRule,
  type SkillLearningResult,
  type AnalyzeOptions,
  type FailureCategory,
} from './skill-learning.js';

export {
  PROJECT_POLICY_VERSION,
  DEFAULT_PROJECT_POLICY,
  getProjectPolicyPath,
  loadProjectPolicy,
  projectPolicyTemplate,
  evaluateProjectPolicyAction,
  evaluateProjectPolicyBatch,
  matchesPolicyPattern,
  normalizePolicyPath,
  type ProjectPolicy,
  type ProjectPolicyLimits,
  type ProjectPolicyState,
  type ProjectPolicyDecision,
  type ProjectPolicyOperation,
} from './project-policy.js';

export {
  EXTERNAL_AGENT_ACTION_SCHEMA,
  EXTERNAL_AGENT_ACTION_SCHEMA_ID,
  EXTERNAL_AGENT_ACTION_SCHEMA_VERSION,
  MAX_AGENT_INPUT_BYTES,
  parseExternalAgentEnvelope,
  validateExternalAgentInput,
  validateTaskContractForActions,
  type ExternalAgentActionEnvelope,
  type ExternalAgentValidation,
  type TaskContract,
  type TaskContractValidation,
} from './action-schema.js';

export {
  suggestProjectPolicy,
  type PolicySuggestion,
  type PolicySuggestionResult,
  type PolicySuggestionRisk,
} from './policy-suggestions.js';

export {
  getRunsDir,
  listRuns,
  readRun,
  saveRunRecord,
  type RunFileSummary,
  type RunRecord,
  type RunSummary,
} from './runs.js';

// Export SWD Receipts
export {
  createSWDReceipt,
  saveSWDReceipt,
  listReceipts,
  readReceipt,
  readReceipts,
  verifyReceipt,
  verifyReceiptIntegrity,
  getReceiptsDir,
  type SWDReceipt,
  type SWDReceiptInput,
  type ReceiptSummary,
  type ReceiptProvider,
  type ReceiptUsage,
  type ReceiptBudget,
  type ReceiptSkill,
  type ReceiptTestStatus,
  type ReceiptTestResult,
  type ReceiptFileResult,
  type ReceiptSnapshot,
  type ReceiptVerification,
  type ReceiptFileVerification,
} from './receipts.js';
export { formatReceiptMarkdown } from './receipt-markdown.js';
export {
  planUndo,
  executeUndo,
  undoReceipt,
  type UndoPlan,
  type UndoPlanItem,
  type UndoExecution,
  type UndoOutcome,
  type UndoClassification,
} from './receipt-undo.js';

// Export the Budget Limiter
export { SessionBudget, type BudgetConfig, type BudgetCheck, type BudgetSnapshot } from './budget.js';

// Export Core Config & Models
export { MODELS, CAPYBARA_SYSTEM_PROMPT, getEffort, validateApiKey, validateProviderKeys, type EffortLevel } from './config.js';

// Export the Chat UI Interface (for custom frontends)
export { type ChatUI } from './commands/chat.js';

export { parseExternalAgentInput, applyExternalAgentActions, type ExternalAgentInput, type SWDApplyResult, type TaskContractSummary } from './commands/swd.js';

// Export the MCP adapter for embedded hosts and tests
export {
  MCP_PROTOCOL_VERSION,
  MCP_TOOLS,
  handleMCPMessage,
  runMCPServer,
  type JsonRpcResponse,
  type JsonRpcSuccessResponse,
  type JsonRpcErrorResponse,
} from './mcp.js';
export {
  MCP_CONFIG_CLIENTS,
  createMCPServerConfig,
  isMCPConfigClient,
  normalizeMCPConfigClient,
  renderMCPConfig,
  type MCPConfigClient,
  type MCPServerConfig,
} from './mcp-config.js';
