// ─────────────────────────────────────────────────────────────
//  mythos-router :: providers/pricing.ts
//  Internal Pricing Registry — provider-agnostic cost engine
//
//  Why: Different APIs report tokens differently (or not at all).
//  This registry decouples financial metrics from provider quirks.
// ─────────────────────────────────────────────────────────────

// ── Per-Model Pricing (USD per token) ────────────────────────
// Source: https://docs.anthropic.com/en/docs/about-claude/pricing
// Source: https://openai.com/api/pricing
// Source: https://api-docs.deepseek.com/pricing
//
// Update these when providers change rates.
interface ModelPricing {
  inputPer1M: number;   // USD per 1M input tokens
  outputPer1M: number;  // USD per 1M output tokens
}

const PRICING_TABLE: Record<string, ModelPricing> = {
  // ── Anthropic ────────────────────────────────────────────
  'claude-opus-4-7':      { inputPer1M: 15.00,  outputPer1M: 75.00 },
  'claude-opus-4-6':      { inputPer1M: 15.00,  outputPer1M: 75.00 },
  'claude-sonnet-4':      { inputPer1M: 3.00,   outputPer1M: 15.00 },
  'claude-sonnet-3-5':    { inputPer1M: 3.00,   outputPer1M: 15.00 },
  'claude-haiku-3':       { inputPer1M: 0.25,   outputPer1M: 1.25 },

  // ── OpenAI ───────────────────────────────────────────────
  'gpt-4o':               { inputPer1M: 2.50,   outputPer1M: 10.00 },
  'gpt-4o-mini':          { inputPer1M: 0.15,   outputPer1M: 0.60 },
  'o1':                   { inputPer1M: 15.00,  outputPer1M: 60.00 },
  'o3':                   { inputPer1M: 10.00,  outputPer1M: 40.00 },
  'o3-mini':              { inputPer1M: 1.10,   outputPer1M: 4.40 },

  // ── DeepSeek ─────────────────────────────────────────────
  'deepseek-chat':        { inputPer1M: 0.27,   outputPer1M: 1.10 },
  'deepseek-reasoner':    { inputPer1M: 0.55,   outputPer1M: 2.19 },
};

// Fallback pricing for unknown models (conservative estimate)
const FALLBACK_PRICING: ModelPricing = { inputPer1M: 5.00, outputPer1M: 20.00 };

// ── Public API ───────────────────────────────────────────────

/**
 * Calculate the cost of a request based on the model used.
 * Falls back to conservative estimates for unknown models.
 */
export function calculateCost(
  modelId: string,
  inputTokens: number,
  outputTokens: number,
): number {
  const pricing = PRICING_TABLE[modelId] ?? FALLBACK_PRICING;
  return (
    (inputTokens / 1_000_000) * pricing.inputPer1M +
    (outputTokens / 1_000_000) * pricing.outputPer1M
  );
}

/**
 * Get the per-token costs for a specific model.
 * Returns null if model is not in the registry.
 */
export function getModelPricing(modelId: string): { inputPerToken: number; outputPerToken: number } {
  const pricing = PRICING_TABLE[modelId] ?? FALLBACK_PRICING;
  return {
    inputPerToken: pricing.inputPer1M / 1_000_000,
    outputPerToken: pricing.outputPer1M / 1_000_000,
  };
}

/**
 * Check if a model has known pricing.
 */
export function hasKnownPricing(modelId: string): boolean {
  return modelId in PRICING_TABLE;
}

/**
 * Get all known model IDs for a given provider prefix.
 */
export function getModelsForProvider(providerPrefix: string): string[] {
  return Object.keys(PRICING_TABLE).filter(id => id.startsWith(providerPrefix));
}
