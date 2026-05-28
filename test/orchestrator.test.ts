import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ProviderOrchestrator } from '../src/providers/orchestrator.js';
import {
  type BaseProvider,
  type Message,
  type ProviderCapability,
  type SendOptions,
  type StreamOptions,
  type UnifiedResponse,
} from '../src/providers/types.js';

function makeResponse(providerId: string, text = 'ok'): UnifiedResponse {
  return {
    thinking: '',
    text,
    toolCalls: [],
    usage: {
      inputTokens: 10,
      outputTokens: 5,
      latencyMs: 20,
    },
    metadata: {
      providerId,
      modelId: `${providerId}-test-model`,
      fallbackTriggered: false,
      incomplete: false,
    },
  };
}

class FakeProvider implements BaseProvider {
  readonly capabilities: ReadonlySet<ProviderCapability>;
  sendCalls = 0;
  streamCalls = 0;

  constructor(
    readonly id: string,
    capabilities: ProviderCapability[] = ['streaming'],
    private readonly behavior: {
      send?: () => Promise<UnifiedResponse>;
      stream?: () => Promise<UnifiedResponse>;
    } = {},
  ) {
    this.capabilities = new Set(capabilities);
  }

  async sendMessage(_messages: Message[], _options: SendOptions): Promise<UnifiedResponse> {
    this.sendCalls++;
    if (this.behavior.send) return this.behavior.send();
    return makeResponse(this.id);
  }

  async streamMessage(_messages: Message[], _options: StreamOptions): Promise<UnifiedResponse> {
    this.streamCalls++;
    if (this.behavior.stream) return this.behavior.stream();
    return makeResponse(this.id);
  }
}

const messages: Message[] = [{ role: 'user', content: 'route this' }];
const sendOptions: SendOptions = { systemPrompt: 'test', effort: 'low' };
const noopTelemetry = {
  updateMetrics: () => {},
  logDecision: () => {},
  logFailure: () => {},
};

describe('ProviderOrchestrator', () => {
  it('uses provider priority as the startup tie-breaker', async () => {
    const orchestrator = new ProviderOrchestrator(noopTelemetry);
    const lowerPriority = new FakeProvider('lower-priority');
    const higherPriority = new FakeProvider('higher-priority');

    orchestrator.registerProvider(lowerPriority, { priority: 10 });
    orchestrator.registerProvider(higherPriority, { priority: 0 });

    const response = await orchestrator.sendMessage(messages, sendOptions);

    assert.equal(response.metadata.providerId, 'higher-priority');
    assert.equal(higherPriority.sendCalls, 1);
    assert.equal(lowerPriority.sendCalls, 0);
  });

  it('falls back to the next provider after a provider failure', async () => {
    const orchestrator = new ProviderOrchestrator(noopTelemetry);
    const failing = new FakeProvider('failing', ['streaming'], {
      send: async () => {
        throw new Error('provider rejected request');
      },
    });
    const fallback = new FakeProvider('fallback');

    orchestrator.registerProvider(failing, { priority: 0 });
    orchestrator.registerProvider(fallback, { priority: 1 });

    const response = await orchestrator.sendMessage(messages, sendOptions);

    assert.equal(response.metadata.providerId, 'fallback');
    assert.equal(response.metadata.fallbackTriggered, true);
    assert.equal(failing.sendCalls, 1);
    assert.equal(fallback.sendCalls, 1);
  });

  it('does not degrade a provider after one exhausted retryable request', async () => {
    const states: Array<{ id: string; degradedUntil: number }> = [];
    const telemetry = {
      updateMetrics: (state: { id: string; degradedUntil: number }) => {
        states.push({ id: state.id, degradedUntil: state.degradedUntil });
      },
      logDecision: () => {},
      logFailure: () => {},
    };
    const orchestrator = new ProviderOrchestrator(telemetry);
    const failing = new FakeProvider('failing', ['streaming'], {
      send: async () => {
        throw new Error('503 service unavailable');
      },
    });
    const fallback = new FakeProvider('fallback');

    orchestrator.registerProvider(failing, { priority: 0 });
    orchestrator.registerProvider(fallback, { priority: 1 });

    const response = await orchestrator.sendMessage(messages, sendOptions);
    const failingStates = states.filter((state) => state.id === 'failing');

    assert.equal(response.metadata.providerId, 'fallback');
    assert.equal(failing.sendCalls, 4);
    assert.equal(failingStates.some((state) => state.degradedUntil > 0), false);
  });

  it('does not call fallback providers when fallback is disabled', async () => {
    const orchestrator = new ProviderOrchestrator(noopTelemetry);
    const failing = new FakeProvider('failing', ['streaming'], {
      send: async () => {
        throw new Error('hard failure');
      },
    });
    const fallback = new FakeProvider('fallback');

    orchestrator.registerProvider(failing, { priority: 0 });
    orchestrator.registerProvider(fallback, { priority: 1 });

    await assert.rejects(
      () => orchestrator.sendMessage(messages, { ...sendOptions, allowFallback: false }),
      /hard failure/,
    );

    assert.equal(failing.sendCalls, 1);
    assert.equal(fallback.sendCalls, 0);
  });
});
