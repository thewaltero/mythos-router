// ─────────────────────────────────────────────────────────────
//  mythos-router :: client.ts
//  Backward-compatible facade over the Provider Orchestrator
//
//  This file preserves the original API surface so that existing
//  consumers (chat.ts, dream.ts, verify.ts, SDK users) continue
//  to work without changes. Under the hood, it delegates to the
//  ProviderOrchestrator for retry, fallback, and scoring.
// ─────────────────────────────────────────────────────────────

import { AnthropicProvider } from './providers/anthropic.js';
import { OpenAIProvider } from './providers/openai.js';
import { ProviderOrchestrator } from './providers/orchestrator.js';
import type { UnifiedResponse } from './providers/types.js';
import {
  CAPYBARA_SYSTEM_PROMPT,
  MODELS,
  validateApiKey,
  getOpenAIKey,
  getDeepSeekKey,
  MAX_OUTPUT_TOKENS_STREAM,
  MAX_OUTPUT_TOKENS_SEND,
  type EffortLevel,
} from './config.js';
import { c, theme } from './utils.js';

// ── Re-export Message for backward compatibility ─────────────
export type { Message } from './providers/types.js';

// ── Legacy Response Type (backward-compatible) ───────────────
export interface MythosResponse {
  thinking: string;
  text: string;
  inputTokens: number;
  outputTokens: number;
  /** Provider metadata (new — optional for backward compat) */
  _orchestration?: {
    providerId: string;
    modelId: string;
    fallbackTriggered: boolean;
    incomplete: boolean;
    latencyMs: number;
  };
}

// ── Singleton Orchestrator ───────────────────────────────────
let _orchestrator: ProviderOrchestrator | null = null;

export function getOrchestrator(): ProviderOrchestrator {
  if (!_orchestrator) {
    const apiKey = validateApiKey();
    _orchestrator = new ProviderOrchestrator();

    // Primary: Anthropic (always registered)
    _orchestrator.registerProvider(
      new AnthropicProvider(apiKey),
      { priority: 0 },
    );

    // Fallback: OpenAI (if OPENAI_API_KEY is set)
    const openaiKey = getOpenAIKey();
    if (openaiKey) {
      _orchestrator.registerProvider(
        new OpenAIProvider({
          id: 'openai',
          apiKey: openaiKey,
          baseUrl: 'https://api.openai.com/v1',
          defaultModel: 'gpt-4o',
        }),
        { priority: 1 },
      );
    }

    // Fallback: DeepSeek (if DEEPSEEK_API_KEY is set)
    const deepseekKey = getDeepSeekKey();
    if (deepseekKey) {
      _orchestrator.registerProvider(
        new OpenAIProvider({
          id: 'deepseek',
          apiKey: deepseekKey,
          baseUrl: 'https://api.deepseek.com/v1',
          defaultModel: 'deepseek-chat',
          supportsThinking: true,
        }),
        { priority: 2 },
      );
    }
  }
  return _orchestrator;
}

// ── Legacy getClient() (for direct SDK access if needed) ─────
import Anthropic from '@anthropic-ai/sdk';

let _client: Anthropic | null = null;
export function getClient(): Anthropic {
  if (!_client) {
    const apiKey = validateApiKey();
    _client = new Anthropic({ apiKey });
  }
  return _client;
}

// ── Convert UnifiedResponse → MythosResponse ─────────────────
function toMythosResponse(unified: UnifiedResponse): MythosResponse {
  return {
    thinking: unified.thinking,
    text: unified.text,
    inputTokens: unified.usage.inputTokens,
    outputTokens: unified.usage.outputTokens,
    _orchestration: {
      providerId: unified.metadata.providerId,
      modelId: unified.metadata.modelId,
      fallbackTriggered: unified.metadata.fallbackTriggered,
      incomplete: unified.metadata.incomplete,
      latencyMs: unified.usage.latencyMs,
    },
  };
}

export async function streamMessage(
  messages: { role: 'user' | 'assistant'; content: string }[],
  effort: EffortLevel = 'high',
  onThinkingDelta?: (text: string) => void,
  onTextDelta?: (text: string) => void,
  maxTokensOverride?: number,
): Promise<MythosResponse> {
  const orchestrator = getOrchestrator();

  const unified = await orchestrator.streamMessage(messages, {
    systemPrompt: CAPYBARA_SYSTEM_PROMPT,
    maxTokens: maxTokensOverride ?? MAX_OUTPUT_TOKENS_STREAM,
    effort,
    onThinkingDelta,
    onTextDelta,
  });

  return toMythosResponse(unified);
}

export async function sendMessage(
  messages: { role: 'user' | 'assistant'; content: string }[],
  effort: EffortLevel = 'low',
  systemOverride?: string,
  maxTokensOverride?: number,
): Promise<MythosResponse> {
  const orchestrator = getOrchestrator();

  const unified = await orchestrator.sendMessage(messages, {
    systemPrompt: systemOverride ?? CAPYBARA_SYSTEM_PROMPT,
    maxTokens: maxTokensOverride ?? MAX_OUTPUT_TOKENS_SEND,
    effort,
  });

  return toMythosResponse(unified);
}

// ── Token cost display ───────────────────────────────────────
export function formatTokenUsage(resp: MythosResponse): string {
  const total = resp.inputTokens + resp.outputTokens;
  const providerInfo = resp._orchestration
    ? ` ${theme.muted}via ${theme.info}${resp._orchestration.providerId}${theme.muted}/${resp._orchestration.modelId}${c.reset}`
    : '';
  const fallbackInfo = resp._orchestration?.fallbackTriggered
    ? ` ${theme.warning}(fallback)${c.reset}`
    : '';

  return (
    `${theme.muted}Tokens: ${theme.info}${resp.inputTokens.toLocaleString()}${theme.muted} in · ` +
    `${theme.info}${resp.outputTokens.toLocaleString()}${theme.muted} out · ` +
    `${theme.warning}${total.toLocaleString()}${theme.muted} total${c.reset}` +
    providerInfo + fallbackInfo
  );
}
