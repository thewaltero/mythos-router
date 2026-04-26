// ─────────────────────────────────────────────────────────────
//  mythos-router :: providers/orchestrator.ts
//  The Mythos Orchestration Engine
//
//  Adaptive routing, retry-before-fallback, circuit breakers,
//  stream watchdogs, and per-provider concurrency control.
//  Zero external dependencies.
// ─────────────────────────────────────────────────────────────

import { createHash } from 'node:crypto';
import { TelemetryStore } from './telemetry.js';
import {
  type BaseProvider,
  type Message,
  type StreamOptions,
  type SendOptions,
  type UnifiedResponse,
  type ProviderConfig,
  type ProviderStatus,
  type ProviderCapability,
  type OrchestrationEvent,
} from './types.js';
import { calculateCost } from './pricing.js';

// ── EMA-Based Model Metrics ──────────────────────────────────
interface ModelMetrics {
  successRate: number;   // EMA of success (0.0 - 1.0)
  avgLatency: number;    // EMA of latency in ms
  prevSuccessRate: number;
  prevAvgLatency: number;
  costPer1k: number;     // Average cost per 1k tokens
  totalCalls: number;
  totalFailures: number;
  lastError: string | null;
  lastErrorTime: number;
}

// ── Provider Slot (runtime state) ────────────────────────────
interface ProviderSlot {
  provider: BaseProvider;
  config: ProviderConfig;
  status: ProviderStatus;
  metrics: ModelMetrics;
  activeConcurrency: number;
  degradedUntil: number;  // Timestamp when circuit breaker resets
}

// ── Retry Configuration ──────────────────────────────────────
const RETRY_BACKOFFS_MS = [100, 500, 1000] as const;
const CIRCUIT_BREAKER_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes
const EMA_ALPHA = 0.3; // Smoothing factor for exponential moving average
const DEFAULT_WATCHDOG_MS = 15_000;
const WATCHDOG_LATENCY_MULTIPLIER = 3;

// ── Retryable Error Detection ────────────────────────────────
const RETRYABLE_STATUS_CODES = new Set([429, 502, 503, 529]);

function isRetryableError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message.toLowerCase();

  // Network errors
  if (msg.includes('econnrefused') || msg.includes('econnreset') ||
      msg.includes('etimedout') || msg.includes('enotfound') ||
      msg.includes('fetch failed') || msg.includes('network')) {
    return true;
  }

  // HTTP status code errors
  for (const code of RETRYABLE_STATUS_CODES) {
    if (msg.includes(String(code))) return true;
  }

  // Anthropic-specific overload messages
  if (msg.includes('overloaded') || msg.includes('rate limit')) return true;

  return false;
}

function extractFallbackReason(err: unknown): OrchestrationEvent['fallbackReason'] {
  if (!(err instanceof Error)) return 'server_error';
  const msg = err.message.toLowerCase();
  if (msg.includes('429') || msg.includes('rate limit')) return 'rate_limit';
  if (msg.includes('timeout') || msg.includes('etimedout')) return 'timeout';
  if (msg.includes('econnrefused') || msg.includes('network') || msg.includes('fetch failed')) return 'network_error';
  return 'server_error';
}

// ── Scoring Algorithm ────────────────────────────────────────
function calculateScore(
  metrics: ModelMetrics,
  taskType: 'chat' | 'code' | 'analysis' | 'unknown' = 'chat',
): number {
  let latencyWeight = 0.05;
  let successWeight = 100;

  // Context-aware biasing
  if (taskType === 'chat') latencyWeight = 0.2;
  if (taskType === 'code' || taskType === 'analysis') successWeight = 150;

  return (
    (metrics.successRate * successWeight) -
    (metrics.avgLatency * latencyWeight) -
    (metrics.costPer1k * 10.0)
  );
}

// ── Deterministic Provider Selection ─────────────────────────
function deterministicSelect(
  messages: Message[],
  providers: ProviderSlot[],
): ProviderSlot {
  // Hash the input to get a stable provider index
  const payload = messages.map(m => `${m.role}:${m.content}`).join('|');
  const hash = createHash('sha256').update(payload).digest();
  const index = hash.readUInt32BE(0) % providers.length;
  return providers[index];
}

// ── The Orchestrator ─────────────────────────────────────────
export class ProviderOrchestrator {
  private slots: ProviderSlot[] = [];
  private eventLog: OrchestrationEvent[] = [];
  private sessionId: string;
  private telemetry: TelemetryStore;

  constructor() {
    this.sessionId = createHash('sha256')
      .update(`${Date.now()}-${Math.random()}`)
      .digest('hex')
      .slice(0, 12);
    this.telemetry = TelemetryStore.getInstance();
  }

  // ── Provider Registration ────────────────────────────────
  registerProvider(provider: BaseProvider, config?: Partial<ProviderConfig>): void {
    const fullConfig: ProviderConfig = {
      id: provider.id,
      priority: config?.priority ?? this.slots.length,
      enabled: config?.enabled ?? true,
      maxConcurrency: config?.maxConcurrency ?? 3,
    };

    this.slots.push({
      provider,
      config: fullConfig,
      status: 'healthy',
      metrics: {
        successRate: 1.0,
        avgLatency: 1000,
        prevSuccessRate: 1.0,
        prevAvgLatency: 1000,
        costPer1k: 0,
        totalCalls: 0,
        totalFailures: 0,
        lastError: null,
        lastErrorTime: 0,
      },
      activeConcurrency: 0,
      degradedUntil: 0,
    });
  }

  // ── Provider Selection (Scored or Deterministic) ─────────
  private selectProvider(
    options: StreamOptions | SendOptions,
    requiredCapabilities?: ProviderCapability[],
  ): ProviderSlot[] {
    const now = Date.now();

    // Reset expired circuit breakers
    for (const slot of this.slots) {
      if (slot.status === 'degraded' && now >= slot.degradedUntil) {
        slot.status = 'healthy';
      }
    }

    // Filter to eligible providers
    let eligible = this.slots.filter(slot => {
      if (!slot.config.enabled) return false;
      if (slot.status === 'down') return false;

      // Capability mismatch check
      if (requiredCapabilities) {
        for (const cap of requiredCapabilities) {
          if (!slot.provider.capabilities.has(cap)) return false;
        }
      }

      // Concurrency check (skip full providers unless they're the only option)
      if (slot.activeConcurrency >= slot.config.maxConcurrency) return false;

      return true;
    });

    // If all providers are at max concurrency, allow degraded ones
    if (eligible.length === 0) {
      eligible = this.slots.filter(slot =>
        slot.config.enabled && slot.status !== 'down'
      );
    }

    if (eligible.length === 0) {
      throw new Error('No providers available. All registered providers are down or disabled.');
    }

    // Deterministic mode: fixed selection via hash
    if (options.deterministic) {
      return eligible; // Return all, but deterministicSelect will pick one
    }

    // Adaptive mode: sort by score (highest first)
    const taskType = options.taskType ?? 'unknown';
    eligible.sort((a, b) => {
      // Healthy providers always beat degraded ones
      if (a.status === 'healthy' && b.status === 'degraded') return -1;
      if (a.status === 'degraded' && b.status === 'healthy') return 1;

      const scoreA = calculateScore(a.metrics, taskType);
      const scoreB = calculateScore(b.metrics, taskType);
      
      // Tie-breaker: if scores are virtually identical (e.g., at startup),
      // respect the explicitly configured provider priority.
      if (Math.abs(scoreA - scoreB) < 0.01) {
        return a.config.priority - b.config.priority;
      }

      return scoreB - scoreA;
    });

    return eligible;
  }

  // ── Update Metrics (EMA) ─────────────────────────────────
  private recordSuccess(slot: ProviderSlot, latencyMs: number, cost: number): void {
    const m = slot.metrics;
    m.prevSuccessRate = m.successRate;
    m.prevAvgLatency = m.avgLatency;
    m.successRate = m.successRate * (1 - EMA_ALPHA) + 1.0 * EMA_ALPHA;
    m.avgLatency = m.avgLatency * (1 - EMA_ALPHA) + latencyMs * EMA_ALPHA;
    m.costPer1k = cost > 0 ? m.costPer1k * (1 - EMA_ALPHA) + cost * EMA_ALPHA : m.costPer1k;
    m.totalCalls++;
    this.pushTelemetryState(slot);
  }

  private recordFailure(slot: ProviderSlot, err: Error): void {
    const m = slot.metrics;
    m.prevSuccessRate = m.successRate;
    m.prevAvgLatency = m.avgLatency;
    m.successRate = m.successRate * (1 - EMA_ALPHA) + 0.0 * EMA_ALPHA;
    m.totalCalls++;
    m.totalFailures++;
    m.lastError = err.message;
    m.lastErrorTime = Date.now();
    this.pushTelemetryState(slot);
  }

  private tripCircuitBreaker(slot: ProviderSlot): void {
    slot.status = 'degraded';
    slot.degradedUntil = Date.now() + CIRCUIT_BREAKER_COOLDOWN_MS;
    this.pushTelemetryState(slot);
  }

  private pushTelemetryState(slot: ProviderSlot): void {
    this.telemetry.updateMetrics({
      id: slot.provider.id,
      successRate: slot.metrics.successRate,
      avgLatency: slot.metrics.avgLatency,
      prevSuccessRate: slot.metrics.prevSuccessRate,
      prevAvgLatency: slot.metrics.prevAvgLatency,
      totalCalls: slot.metrics.totalCalls,
      totalFailures: slot.metrics.totalFailures,
      degradedUntil: slot.degradedUntil
    });
  }

  // ── Adaptive Watchdog Timeout ────────────────────────────
  private getWatchdogTimeout(slot: ProviderSlot): number {
    return Math.max(DEFAULT_WATCHDOG_MS, slot.metrics.avgLatency * WATCHDOG_LATENCY_MULTIPLIER);
  }

  // ── Retry with Exponential Backoff ───────────────────────
  private async retryWithBackoff<T>(
    slot: ProviderSlot,
    fn: () => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    let lastErr: Error | null = null;

    for (let attempt = 0; attempt <= RETRY_BACKOFFS_MS.length; attempt++) {
      try {
        return await fn();
      } catch (err) {
        lastErr = err instanceof Error ? err : new Error(String(err));

        // Non-retryable errors fail immediately
        if (!isRetryableError(err)) throw lastErr;

        // Exhausted retries
        if (attempt >= RETRY_BACKOFFS_MS.length) break;

        // Check abort signal
        if (signal?.aborted) throw lastErr;

        // Backoff delay
        const delay = RETRY_BACKOFFS_MS[attempt];
        await new Promise<void>(resolve => {
          const timer = setTimeout(resolve, delay);
          if (signal) {
            const onAbort = () => { clearTimeout(timer); resolve(); };
            signal.addEventListener('abort', onAbort, { once: true });
          }
        });
      }
    }

    // Trip circuit breaker after exhausting retries
    this.recordFailure(slot, lastErr!);
    this.tripCircuitBreaker(slot);
    throw lastErr!;
  }

  // ── Stream Message (Primary API) ─────────────────────────
  private logRoutingDecision(
    messages: Message[],
    taskType: 'chat' | 'code' | 'analysis' | 'unknown',
    candidates: ProviderSlot[]
  ): void {
    if (candidates.length === 0) return;
    
    const totalChars = messages.reduce((acc, m) => acc + m.content.length, 0);
    const tokenEstimate = Math.ceil(totalChars / 4);
    let bucket = '<4k';
    if (tokenEstimate >= 4000 && tokenEstimate < 16000) bucket = '4k-16k';
    else if (tokenEstimate >= 16000) bucket = '>16k';

    const winner = candidates[0];
    let reasoning = `Selected as only viable provider.`;
    if (candidates.length > 1) {
      const runnerUp = candidates[1];
      const winScore = calculateScore(winner.metrics, taskType).toFixed(1);
      const runScore = calculateScore(runnerUp.metrics, taskType).toFixed(1);
      reasoning = `Score (${winScore}) beat ${runnerUp.provider.id} (${runScore}). EMA Latency: ${winner.metrics.avgLatency.toFixed(0)}ms vs ${runnerUp.metrics.avgLatency.toFixed(0)}ms.`;
    }

    this.telemetry.logDecision({
      timestamp: Date.now(),
      selectedProvider: winner.provider.id,
      taskType,
      inputSizeBucket: bucket,
      reasoning
    });
  }

  async streamMessage(
    messages: Message[],
    options: StreamOptions,
  ): Promise<UnifiedResponse> {
    const candidates = this.selectProvider(options);
    const taskType = options.taskType ?? 'unknown';
    this.logRoutingDecision(messages, taskType, candidates);

    let fallbackTriggered = false;
    let primaryProvider = candidates[0]?.provider.id ?? 'none';
    let retryCount = 0;

    for (const slot of candidates) {
      // Acquire concurrency slot
      slot.activeConcurrency++;

      try {
        // Set up the adaptive watchdog
        const watchdogMs = this.getWatchdogTimeout(slot);
        const watchdogController = new AbortController();
        let watchdogTimer: ReturnType<typeof setTimeout> | null = null;
        let lastChunkTime = Date.now();

        // Create a composite abort signal
        const compositeSignal = options.signal
          ? AbortSignal.any([options.signal, watchdogController.signal])
          : watchdogController.signal;

        // Start watchdog
        const resetWatchdog = () => {
          lastChunkTime = Date.now();
          if (watchdogTimer) clearTimeout(watchdogTimer);
          watchdogTimer = setTimeout(() => {
            watchdogController.abort();
          }, watchdogMs);
        };
        resetWatchdog();

        // Wrap callbacks to reset watchdog on every chunk
        const wrappedOptions: StreamOptions = {
          ...options,
          signal: compositeSignal,
          onThinkingDelta: (text) => {
            resetWatchdog();
            options.onThinkingDelta?.(text);
          },
          onTextDelta: (text) => {
            resetWatchdog();
            options.onTextDelta?.(text);
          },
        };

        const response = await this.retryWithBackoff(
          slot,
          () => slot.provider.streamMessage(messages, wrappedOptions),
          compositeSignal,
        );

        // Clear watchdog
        if (watchdogTimer) clearTimeout(watchdogTimer);

        // Record success metrics
        const cost = calculateCost(
          response.metadata.modelId,
          response.usage.inputTokens,
          response.usage.outputTokens,
        );
        this.recordSuccess(slot, response.usage.latencyMs, cost);

        // Stamp metadata
        response.metadata.fallbackTriggered = fallbackTriggered;

        // Log orchestration event
        this.logEvent({
          timestamp: new Date().toISOString(),
          sessionId: this.sessionId,
          command: 'stream',
          primaryProvider,
          actualProvider: slot.provider.id,
          fallbackReason: fallbackTriggered ? 'server_error' : undefined,
          latencyMs: response.usage.latencyMs,
          cost,
          retryCount,
        });

        return response;

      } catch (err) {
        // Release concurrency slot
        slot.activeConcurrency--;

        const error = err instanceof Error ? err : new Error(String(err));

        // If this was a watchdog abort, mark incomplete
        if (error.message === 'Stream aborted by signal' || error.message.includes('aborted')) {
          // The provider should have returned a partial response
          // but if it threw, we need to continue to fallback
        }

        // Record failure and prepare for fallback
        this.recordFailure(slot, error);
        retryCount++;
        fallbackTriggered = true;

        const reason = extractFallbackReason(err);
        
        this.telemetry.logFailure({
          timestamp: Date.now(),
          provider: slot.provider.id,
          errorType: reason ?? 'server_error',
          shortMessage: error.message.slice(0, 100),
          fullStack: error.stack || error.message
        });

        this.logEvent({
          timestamp: new Date().toISOString(),
          sessionId: this.sessionId,
          command: 'stream',
          primaryProvider,
          actualProvider: slot.provider.id,
          fallbackReason: reason,
          latencyMs: 0,
          cost: 0,
          retryCount,
        });

        // Deterministic mode: don't fallback (except hard 5xx)
        if (options.deterministic) {
          throw new Error(
            `[orchestrator] Deterministic mode: ${slot.provider.id} failed and fallback is disabled. ` +
            `Error: ${error.message}`
          );
        }

        // Try next provider
        continue;
      } finally {
        // Ensure concurrency slot is released (if not already)
        if (slot.activeConcurrency > 0) {
          slot.activeConcurrency--;
        }
      }
    }

    throw new Error('[orchestrator] All providers exhausted. No response generated.');
  }

  // ── Send Message (Non-Streaming) ─────────────────────────
  async sendMessage(
    messages: Message[],
    options: SendOptions,
  ): Promise<UnifiedResponse> {
    const candidates = this.selectProvider(options);
    const taskType = options.taskType ?? 'unknown';
    this.logRoutingDecision(messages, taskType, candidates);

    let fallbackTriggered = false;
    let primaryProvider = candidates[0]?.provider.id ?? 'none';
    let retryCount = 0;

    for (const slot of candidates) {
      slot.activeConcurrency++;

      try {
        const response = await this.retryWithBackoff(
          slot,
          () => slot.provider.sendMessage(messages, options),
          options.signal,
        );

        const cost = calculateCost(
          response.metadata.modelId,
          response.usage.inputTokens,
          response.usage.outputTokens,
        );
        this.recordSuccess(slot, response.usage.latencyMs, cost);
        response.metadata.fallbackTriggered = fallbackTriggered;

        this.logEvent({
          timestamp: new Date().toISOString(),
          sessionId: this.sessionId,
          command: 'send',
          primaryProvider,
          actualProvider: slot.provider.id,
          fallbackReason: fallbackTriggered ? 'server_error' : undefined,
          latencyMs: response.usage.latencyMs,
          cost,
          retryCount,
        });

        return response;

      } catch (err) {
        slot.activeConcurrency--;
        const error = err instanceof Error ? err : new Error(String(err));
        this.recordFailure(slot, error);
        retryCount++;
        fallbackTriggered = true;

        this.telemetry.logFailure({
          timestamp: Date.now(),
          provider: slot.provider.id,
          errorType: 'server_error',
          shortMessage: error.message.slice(0, 100),
          fullStack: error.stack || error.message
        });

        if (options.deterministic) {
          throw new Error(
            `[orchestrator] Deterministic mode: ${slot.provider.id} failed. Error: ${error.message}`
          );
        }

        continue;
      } finally {
        if (slot.activeConcurrency > 0) {
          slot.activeConcurrency--;
        }
      }
    }

    throw new Error('[orchestrator] All providers exhausted. No response generated.');
  }

  // ── Observability ────────────────────────────────────────
  private logEvent(event: OrchestrationEvent): void {
    this.eventLog.push(event);
    // Keep last 200 events in memory
    if (this.eventLog.length > 200) {
      this.eventLog = this.eventLog.slice(-200);
    }
  }

  getEventLog(): readonly OrchestrationEvent[] {
    return this.eventLog;
  }

  getProviderHealth(): Array<{
    id: string;
    status: ProviderStatus;
    score: number;
    metrics: ModelMetrics;
    concurrency: number;
  }> {
    return this.slots.map(slot => ({
      id: slot.provider.id,
      status: slot.status,
      score: calculateScore(slot.metrics),
      metrics: { ...slot.metrics },
      concurrency: slot.activeConcurrency,
    }));
  }

  getSessionId(): string {
    return this.sessionId;
  }

  // ── Provider Count ───────────────────────────────────────
  get providerCount(): number {
    return this.slots.filter(s => s.config.enabled).length;
  }
}
