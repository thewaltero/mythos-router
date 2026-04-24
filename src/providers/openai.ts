// ─────────────────────────────────────────────────────────────
//  mythos-router :: providers/openai.ts
//  OpenAI-compatible provider — works with OpenAI, DeepSeek,
//  Grok, and any OpenAI-compatible endpoint.
//
//  Zero dependencies: uses native fetch() (Node 20+).
//  Handles SSE streaming, reasoning_content (DeepSeek/o1),
//  and standard content deltas.
// ─────────────────────────────────────────────────────────────

import {
  type BaseProvider,
  type Message,
  type StreamOptions,
  type SendOptions,
  type UnifiedResponse,
  type ProviderCapability,
} from './types.js';

// ── Provider Configuration ───────────────────────────────────
export interface OpenAIProviderConfig {
  id: string;                // e.g. 'openai', 'deepseek', 'grok'
  apiKey: string;
  baseUrl: string;           // e.g. 'https://api.openai.com/v1'
  defaultModel: string;      // e.g. 'gpt-4o', 'deepseek-chat'
  supportsThinking?: boolean; // DeepSeek reasoner, o1/o3 have reasoning
}

// ── SSE Line Parser ──────────────────────────────────────────
function parseSSELine(line: string): Record<string, unknown> | null {
  if (!line.startsWith('data: ')) return null;
  const data = line.slice(6).trim();
  if (data === '[DONE]') return null;
  try {
    return JSON.parse(data);
  } catch {
    return null;
  }
}

// ── OpenAI-Compatible Provider ───────────────────────────────
export class OpenAIProvider implements BaseProvider {
  readonly id: string;
  readonly capabilities: ReadonlySet<ProviderCapability>;

  private apiKey: string;
  private baseUrl: string;
  private defaultModel: string;
  private supportsThinking: boolean;

  constructor(config: OpenAIProviderConfig) {
    this.id = config.id;
    this.apiKey = config.apiKey;
    this.baseUrl = config.baseUrl.replace(/\/+$/, ''); // Strip trailing slash
    this.defaultModel = config.defaultModel;
    this.supportsThinking = config.supportsThinking ?? false;

    const caps: ProviderCapability[] = ['streaming'];
    if (this.supportsThinking) caps.push('thinking');
    this.capabilities = new Set(caps);
  }

  // ── Streaming Message ────────────────────────────────────
  async streamMessage(
    messages: Message[],
    options: StreamOptions,
  ): Promise<UnifiedResponse> {
    const model = this.defaultModel;
    const startTime = Date.now();

    const body: Record<string, unknown> = {
      model,
      messages: [
        { role: 'system', content: options.systemPrompt },
        ...messages.map(m => ({ role: m.role, content: m.content })),
      ],
      max_tokens: options.maxTokens ?? 16384,
      stream: true,
    };

    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: options.signal,
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => 'Unknown error');
      throw new Error(
        `[${this.id}] API error ${response.status}: ${errorText}`
      );
    }

    if (!response.body) {
      throw new Error(`[${this.id}] No response body received`);
    }

    let thinkingText = '';
    let responseText = '';
    let inputTokens = 0;
    let outputTokens = 0;

    // Parse SSE stream
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (true) {
        if (options.signal?.aborted) break;

        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || ''; // Keep incomplete line in buffer

        for (const line of lines) {
          const parsed = parseSSELine(line);
          if (!parsed) continue;

          // Extract delta content
          const choices = parsed.choices as Array<{
            delta?: {
              content?: string;
              reasoning_content?: string;
            };
            finish_reason?: string;
          }> | undefined;

          if (choices?.[0]?.delta) {
            const delta = choices[0].delta;

            // Reasoning/thinking content (DeepSeek reasoner, o1/o3)
            if (delta.reasoning_content) {
              thinkingText += delta.reasoning_content;
              options.onThinkingDelta?.(delta.reasoning_content);
            }

            // Standard content
            if (delta.content) {
              responseText += delta.content;
              options.onTextDelta?.(delta.content);
            }
          }

          // Extract usage from final chunk (if provided)
          const usage = parsed.usage as {
            prompt_tokens?: number;
            completion_tokens?: number;
          } | undefined;

          if (usage) {
            inputTokens = usage.prompt_tokens ?? inputTokens;
            outputTokens = usage.completion_tokens ?? outputTokens;
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    // Estimate tokens if not provided by the API
    if (inputTokens === 0) {
      inputTokens = Math.ceil(
        messages.reduce((acc, m) => acc + m.content.length, 0) / 4
      );
    }
    if (outputTokens === 0) {
      outputTokens = Math.ceil((responseText.length + thinkingText.length) / 4);
    }

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
        incomplete: !!options.signal?.aborted,
      },
    };
  }

  // ── Non-Streaming Message ────────────────────────────────
  async sendMessage(
    messages: Message[],
    options: SendOptions,
  ): Promise<UnifiedResponse> {
    const model = this.defaultModel;
    const startTime = Date.now();

    const body: Record<string, unknown> = {
      model,
      messages: [
        { role: 'system', content: options.systemPrompt },
        ...messages.map(m => ({ role: m.role, content: m.content })),
      ],
      max_tokens: options.maxTokens ?? 8192,
    };

    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: options.signal,
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => 'Unknown error');
      throw new Error(
        `[${this.id}] API error ${response.status}: ${errorText}`
      );
    }

    const data = await response.json() as {
      choices?: Array<{
        message?: {
          content?: string;
          reasoning_content?: string;
        };
      }>;
      usage?: {
        prompt_tokens?: number;
        completion_tokens?: number;
      };
    };

    const choice = data.choices?.[0]?.message;
    const thinkingText = choice?.reasoning_content ?? '';
    const responseText = choice?.content ?? '';
    const inputTokens = data.usage?.prompt_tokens ?? Math.ceil(
      messages.reduce((acc, m) => acc + m.content.length, 0) / 4
    );
    const outputTokens = data.usage?.completion_tokens ?? Math.ceil(
      (responseText.length + thinkingText.length) / 4
    );

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
}
