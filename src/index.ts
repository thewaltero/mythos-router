// ─────────────────────────────────────────────────────────────
//  mythos-router :: index.ts
//  Public API / SDK Exports
// ─────────────────────────────────────────────────────────────

// Export the Backward-Compatible Client Facade
export { getClient, getOrchestrator, streamMessage, sendMessage, formatTokenUsage, type Message, type MythosResponse } from './client.js';

// Export the Provider Orchestration Engine
export { ProviderOrchestrator } from './providers/orchestrator.js';
export { AnthropicProvider } from './providers/anthropic.js';
export { OpenAIProvider, type OpenAIProviderConfig } from './providers/openai.js';
export {
  calculateCost,
  estimateCost,
  getModelPricing,
  getProviderMultiplier,
  hasKnownPricing,
  type CostEstimate,
} from './providers/pricing.js';
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
  type ProviderFailureReason,
  ProviderError,
  isRetryableKind,
  kindFromStatus,
  type ProviderErrorKind,
  type ProviderErrorOptions,
  type ToolDefinition,
  type MessageContentBlock,
  type TextMessageBlock,
  type ToolCallMessageBlock,
  type ToolResultMessageBlock,
} from './providers/types.js';
export { isRetryableError } from './providers/orchestrator.js';
export {
  normalizeMessage,
  normalizeMessages,
  assistantMessageFromResponse,
  toolResultMessage,
  messageCharLength,
  messagesCharLength,
  serializeMessageForRouting,
  adjustCompressionBoundary,
  type ToolResultInput,
} from './providers/messages.js';
export {
  extractStatusCode,
  failureReasonFromError,
  normalizeProviderError,
  type NormalizeProviderErrorOptions,
} from './providers/errors.js';
export {
  FILE_ACTION_TOOL,
  FILE_ACTION_TOOL_NAME,
  toolCallsToActions,
  toAnthropicTool,
  toOpenAITool,
  extractAnthropicToolCalls,
  extractOpenAIToolCalls,
} from './providers/tools.js';


export {
  WorkspaceContext,
  createWorkspaceContext,
  resolveWorkspace,
  type WorkspaceContextOptions,
  type WorkspaceInput,
} from './workspace.js';

export {
  saveSession,
  loadSession,
  getSessionPaths,
  parseSessionData,
  serializeSessionData,
  formatResumeInfo,
  type SessionData,
  type SessionPaths,
} from './session.js';

// Export the Strict Write Discipline Engine (v1 API — Pure Kernel)
export {
  SWDEngine,
  parseActions,
  actionsFromToolCalls,
  snapshotFile,
  resolveSafePath,
  summarizeActions,
  type FileAction,
  type ToolCallFileAction,
  type ActionIntent,
  type ActionResult,
  type VerificationStatus,
  type SWDRunResult,
  type SWDRollbackStatus,
  type SWDOptions,
  type FileSnapshot,
  type FileSnapshotSummary,
} from './swd.js';

// Export the SWD CLI Presentation Layer
export { printSWDResults, dryRunSWD, printVerboseParse } from './swd-cli.js';

// Export the Self-Healing Memory
export {
  readMemory,
  writeCompressedMemory,
  initMemory,
  appendEntry,
  appendMetadataBlock,
  needsDream,
  getMemoryContext,
  getMemoryPath,
  getDbPath,
  getEntryCount,
  searchMemory,
  closeMemoryDatabase,
  type MemoryEntry,
} from './memory.js';

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
  PROJECT_POLICY_SCHEMA,
  PROJECT_POLICY_SCHEMA_ID,
  MAX_POLICY_PATTERNS,
  MAX_POLICY_PATTERN_LENGTH,
  MAX_POLICY_ACTIONS,
  MAX_POLICY_CHECKS,
  MAX_POLICY_CHECK_NAME_LENGTH,
  MAX_POLICY_CHECK_COMMAND_LENGTH,
  DEFAULT_PROJECT_POLICY,
  getProjectPolicyPath,
  loadProjectPolicy,
  projectPolicyTemplate,
  validateProjectPolicy,
  evaluateProjectPolicyAction,
  evaluateProjectPolicyBatch,
  matchesPolicyPattern,
  normalizePolicyPath,
  type ProjectPolicy,
  type ProjectPolicyLimits,
  type ProjectPolicyCheck,
  type ProjectPolicyState,
  type ProjectPolicyDecision,
  type ProjectPolicyOperation,
} from './project-policy.js';

export {
  EXTERNAL_AGENT_ACTION_SCHEMA,
  EXTERNAL_AGENT_ACTION_SCHEMA_ID,
  EXTERNAL_AGENT_ACTION_SCHEMA_VERSION,
  MAX_AGENT_INPUT_BYTES,
  MAX_EXTERNAL_AGENT_ACTIONS,
  MAX_ACTION_PATH_LENGTH,
  MAX_ACTION_DESCRIPTION_LENGTH,
  MAX_ENVELOPE_TEXT_LENGTH,
  MAX_AGENT_ID_LENGTH,
  MAX_AGENT_MODEL_LENGTH,
  MAX_CONTRACT_PATTERNS,
  MAX_CONTRACT_PATTERN_LENGTH,
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
  verifyReceiptChain,
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
  type ReceiptChain,
  type ChainHead,
  type ChainVerification,
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
  type JsonRpcNotification,
  type ProgressToken,
  type ProgressReporter,
  type HandleMCPMessageOptions,
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

// Export persistent transaction recovery and workspace diagnostics
export {
  SWDTransactionJournal,
  inspectTransactionJournals,
  recoverInterruptedTransactions,
  type TransactionState,
  type TransactionEntryState,
  type TransactionFileState,
  type TransactionEntry,
  type TransactionJournalData,
  type TransactionInspection,
  type TransactionRecoveryResult,
} from './transaction-journal.js';
export {
  runDoctor,
  type DoctorCheckStatus,
  type DoctorCheck,
  type DoctorReport,
  type DoctorOptions,
} from './doctor.js';
export { mirrorWorkspaceForSandbox } from './sandbox-files.js';
