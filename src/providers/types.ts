// ── Unified Message Format ───────────────────────────────────
export interface Message {
  role: 'user' | 'assistant';
  content: string;
}

// ── Streaming Chunks ─────────────────────────────────────────
// Every provider MUST normalize its raw stream into this format.
// Invariant: thinking chunks MUST arrive before text chunks.
export interface UnifiedChunk {
  type: 'thinking' | 'text' | 'tool_call_delta';
  content: string;
}

// ── Tool Calls ───────────────────────────────────────────────
export interface UnifiedToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

// ── Unified Response ─────────────────────────────────────────
// The final output of any provider call, whether streamed or not.
// Invariant: Must perfectly match concatenated streamed chunks.
export interface UnifiedResponse {
  thinking: string;
  text: string;
  toolCalls: UnifiedToolCall[];
  usage: {
    inputTokens: number;
    outputTokens: number;
    latencyMs: number;
  };
  metadata: {
    providerId: string;
    modelId: string;
    fallbackTriggered: boolean;
    incomplete: boolean;
  };
}

// ── Request Options ──────────────────────────────────────────
export interface RequestOptions {
  taskType?: 'chat' | 'code' | 'analysis' | 'unknown';
  deterministic?: boolean;
  signal?: AbortSignal;
}

// ── Stream Options (extends Request with callbacks) ──────────
export interface StreamOptions extends RequestOptions {
  systemPrompt: string;
  maxTokens?: number;
  effort?: string;
  onThinkingDelta?: (text: string) => void;
  onTextDelta?: (text: string) => void;
}

// ── Send Options (non-streaming) ─────────────────────────────
export interface SendOptions extends RequestOptions {
  systemPrompt: string;
  maxTokens?: number;
  effort?: string;
}

// ── Provider Capabilities ────────────────────────────────────
export type ProviderCapability = 'thinking' | 'tool_calling' | 'streaming';

// ── Provider Health Status ───────────────────────────────────
export type ProviderStatus = 'healthy' | 'degraded' | 'down';

// ── Base Provider Interface ──────────────────────────────────
// Every LLM backend MUST implement this contract.
// The orchestrator never touches raw provider APIs directly.
export interface BaseProvider {
  readonly id: string;
  readonly capabilities: ReadonlySet<ProviderCapability>;

  streamMessage(
    messages: Message[],
    options: StreamOptions,
  ): Promise<UnifiedResponse>;

  sendMessage(
    messages: Message[],
    options: SendOptions,
  ): Promise<UnifiedResponse>;
}

// ── Provider Registration Config ─────────────────────────────
export interface ProviderConfig {
  id: string;
  priority: number;         // Lower = higher priority in fallback chain
  enabled: boolean;
  maxConcurrency: number;   // Per-provider token bucket limit
}

// ── Orchestration Event (for observability) ──────────────────
export interface OrchestrationEvent {
  timestamp: string;
  sessionId: string;
  command: string;
  primaryProvider: string;
  actualProvider: string;
  fallbackReason?: 'timeout' | 'rate_limit' | 'server_error' | 'capability_mismatch' | 'network_error';
  latencyMs: number;
  cost: number;
  retryCount: number;
}
