// ─────────────────────────────────────────────────────────────
//  mythos-router :: providers/anthropic.ts
//  Anthropic SDK provider — wraps Claude into BaseProvider
//
//  This is the reference implementation. All future providers
//  (OpenAI, DeepSeek) must conform to the same contract.
// ─────────────────────────────────────────────────────────────

import Anthropic from '@anthropic-ai/sdk';
import {
  type BaseProvider,
  type Message,
  type StreamOptions,
  type SendOptions,
  type UnifiedResponse,
  type ProviderCapability,
} from './types.js';
import { MODELS, CAPYBARA_SYSTEM_PROMPT } from '../config.js';

// ── SDK delta types (not exported by Anthropic SDK) ──────────
interface ThinkingDelta {
  type: 'thinking_delta';
  thinking: string;
}

interface TextDelta {
  type: 'text_delta';
  text: string;
}

type ContentDelta = ThinkingDelta | TextDelta;

// ── Anthropic Provider ───────────────────────────────────────
export class AnthropicProvider implements BaseProvider {
  readonly id = 'anthropic';
  readonly capabilities: ReadonlySet<ProviderCapability> = new Set([
    'thinking',
    'streaming',
  ]);

  private client: Anthropic;

  constructor(apiKey: string) {
    this.client = new Anthropic({ apiKey });
  }

  // ── Input Validation ─────────────────────────────────────
  private sanitizeMessages(messages: Message[]): Message[] {
    return messages.map((m, i) => {
      if (m.role !== 'user' && m.role !== 'assistant') {
        throw new Error(`Invalid role at message[${i}]: ${String(m.role)}`);
      }
      if (typeof m.content !== 'string') {
        throw new Error(`Message[${i}] content must be a string`);
      }
      const trimmed = m.content.trim();
      if (trimmed.length === 0) {
        throw new Error(`Empty message content at message[${i}]`);
      }
      return { role: m.role, content: trimmed };
    });
  }

  // ── Resolve model from effort level ──────────────────────
  private resolveModel(effort?: string): string {
    if (effort && effort in MODELS) return MODELS[effort];
    return MODELS.high;
  }
  
  // ── Extended-thinking budget from effort level ───────────
  // The real Anthropic Messages API expects
  //   thinking: { type: 'enabled', budget_tokens: N }
  // where budget_tokens is >= 1024 and STRICTLY less than max_tokens
  // (the thinking budget is drawn from the max_tokens pool).
  // 'low' effort — and any case without enough headroom for both a
  // minimal think and a minimal answer — disables extended thinking.
  private resolveThinking(
    effort: string,
    maxTokens: number,
  ): { type: 'enabled'; budget_tokens: number } | undefined {
    const target = effort === 'high' ? 10_000 : effort === 'medium' ? 4_000 : 0;
    if (target <= 0) return undefined;

    // Reserve at least 1024 tokens for the actual answer.
    const budget = Math.min(target, maxTokens - 1024);
    if (budget < 1024) return undefined;

    return { type: 'enabled', budget_tokens: budget };
  }

  // ── Streaming Message ────────────────────────────────────
  async streamMessage(
    messages: Message[],
    options: StreamOptions,
  ): Promise<UnifiedResponse> {
    const apiMessages = this.sanitizeMessages(messages);
    const effort = options.effort ?? 'high';
    const model = this.resolveModel(effort);
    const maxTokens = options.maxTokens ?? 16384;
    const systemPrompt = options.systemPrompt || CAPYBARA_SYSTEM_PROMPT;
    const startTime = Date.now();

    let thinkingText = '';
    let responseText = '';
    let inputTokens = 0;
    let outputTokens = 0;

    let stream;
    try {
      const supportsThinking = model.includes('opus') || model.includes('sonnet');
      const thinking = supportsThinking ? this.resolveThinking(effort, maxTokens) : undefined;
      stream = await this.client.messages.stream({
        model,
        max_tokens: maxTokens,
        ...(thinking ? { thinking } : {}),
        system: systemPrompt,
        messages: apiMessages,
      }, { signal: options.signal });
    } catch (err) {
      throw new Error(`[anthropic] Failed to start stream: ${err instanceof Error ? err.message : String(err)}`);
    }

    try {
      for await (const event of stream) {
        // Check abort signal
        if (options.signal?.aborted) {
          throw new Error('Stream aborted by signal');
        }

        if (event.type === 'content_block_delta') {
          const delta = event.delta as ContentDelta;

          if (delta.type === 'thinking_delta') {
            thinkingText += delta.thinking;
            options.onThinkingDelta?.(delta.thinking);
          } else if (delta.type === 'text_delta') {
            responseText += delta.text;
            options.onTextDelta?.(delta.text);
          }
        }
      }
    } catch (err) {
      // If aborted, return partial result
      if (options.signal?.aborted) {
        return {
          thinking: thinkingText,
          text: responseText,
          toolCalls: [],
          usage: {
            inputTokens: 0,
            outputTokens: 0,
            latencyMs: Date.now() - startTime,
          },
          metadata: {
            providerId: this.id,
            modelId: model,
            fallbackTriggered: false,
            incomplete: true,
          },
        };
      }
      throw new Error(`[anthropic] Stream interrupted: ${err instanceof Error ? err.message : String(err)}`);
    }

    const finalMessage = await stream.finalMessage();
    inputTokens = finalMessage.usage?.input_tokens ?? 0;
    outputTokens = finalMessage.usage?.output_tokens ?? 0;

    return {
      thinking: thinkingText,
      text: responseText,
      toolCalls: [],
      usage: {
        inputTokens,
        outputTokens,
        latencyMs: Date.now() - startTime,
      },
      metadata: {
        providerId: this.id,
        modelId: model,
        fallbackTriggered: false,
        incomplete: false,
      },
    };
  }

  // ── Non-Streaming Message ────────────────────────────────
  async sendMessage(
    messages: Message[],
    options: SendOptions,
  ): Promise<UnifiedResponse> {
    const apiMessages = this.sanitizeMessages(messages);
    const effort = options.effort ?? 'low';
    const model = this.resolveModel(effort);
    const maxTokens = options.maxTokens ?? 8192;
    const systemPrompt = options.systemPrompt || CAPYBARA_SYSTEM_PROMPT;
    const startTime = Date.now();

    let response;
    try {
      const supportsThinking = model.includes('opus') || model.includes('sonnet');
      const thinking = supportsThinking ? this.resolveThinking(effort, maxTokens) : undefined;
      response = await this.client.messages.create({
        model,
        max_tokens: maxTokens,
        ...(thinking ? { thinking } : {}),
        system: systemPrompt,
        messages: apiMessages,
      }, { signal: options.signal });
    } catch (err) {
      throw new Error(`[anthropic] API request failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    let thinkingText = '';
    let responseText = '';

    for (const block of response.content) {
      if (block.type === 'thinking') {
        thinkingText += block.thinking ?? '';
      } else if (block.type === 'text') {
        responseText += block.text;
      }
    }

    return {
      thinking: thinkingText,
      text: responseText,
      toolCalls: [],
      usage: {
        inputTokens: response.usage?.input_tokens ?? 0,
        outputTokens: response.usage?.output_tokens ?? 0,
        latencyMs: Date.now() - startTime,
      },
      metadata: {
        providerId: this.id,
        modelId: model,
        fallbackTriggered: false,
        incomplete: false,
      },
    };
  }
}
