// ─────────────────────────────────────────────────────────────
//  mythos-router :: context-guard.ts
//  Pure helpers for the chat Context Window Guard.
//
//  The guard estimates prompt tokens from character length. Real tokenizers
//  vary (English ≈ 4 chars/token; dense code/JSON can be ≈ 3), so a single
//  fixed divisor either over-counts (premature compression) or under-counts
//  (overflow risk). These helpers let ChatSession seed a rough default and then
//  CALIBRATE the density against the real input-token counts the provider
//  returns. The math lives here, free of any session/orchestrator state, so it
//  can be unit-tested directly.
// ─────────────────────────────────────────────────────────────

export const DEFAULT_CHARS_PER_TOKEN = 4;
export const MIN_CHARS_PER_TOKEN = 2; // densest realistic tokenization (code/JSON)
export const MAX_CHARS_PER_TOKEN = 6; // loosest realistic tokenization
export const CALIBRATION_EMA_ALPHA = 0.3; // smoothing for the running density estimate
export const MIN_CALIBRATION_SAMPLES = 3; // trust the calibrated value after this many real turns
// Once calibrated the estimate is more accurate, so the safety margin shrinks.
export const UNCALIBRATED_TOKEN_MARGIN = 1.2;
export const CALIBRATED_TOKEN_MARGIN = 1.1;
// Adaptive compression: target the kept (post-compression) history to sit at or
// under this fraction of the effective limit, so dense sessions shed more than
// the fixed floor instead of compressing again on the very next turn.
export const COMPRESSION_TARGET_FRACTION = 0.5;
export const MIN_COMPRESSION_FRACTION = 0.6; // never compress less than the original 60% floor

/**
 * Estimate prompt tokens for a character count at a given density. The safety
 * margin shrinks once the density has been calibrated against real usage,
 * because the estimate is then much closer to reality.
 */
export function estimateTokens(chars: number, charsPerToken: number, calibrated: boolean): number {
  if (!Number.isFinite(chars) || chars <= 0) return 0;
  const density = Number.isFinite(charsPerToken) && charsPerToken > 0 ? charsPerToken : DEFAULT_CHARS_PER_TOKEN;
  const margin = calibrated ? CALIBRATED_TOKEN_MARGIN : UNCALIBRATED_TOKEN_MARGIN;
  return Math.ceil((chars / density) * margin);
}

/** Clamp an observed chars/token ratio into the plausible tokenizer band. */
export function clampDensity(ratio: number): number {
  if (!Number.isFinite(ratio)) return DEFAULT_CHARS_PER_TOKEN;
  return Math.min(MAX_CHARS_PER_TOKEN, Math.max(MIN_CHARS_PER_TOKEN, ratio));
}

/**
 * Compute the next calibrated density from a real turn. `observedChars` is the
 * exact number of characters sent (system prompt + full history); the provider
 * reports the input tokens it actually charged for, so the ratio is the true
 * tokenizer density. Clamped and EMA-smoothed so a prompt-cache hit (which
 * under-reports input tokens) or an estimated-usage fallback can't drag the
 * calibration to an unrealistic value. Invalid inputs leave the density
 * unchanged.
 */
export function nextDensity(
  current: number,
  observedChars: number,
  reportedInputTokens: number,
  samples: number,
): number {
  if (!Number.isFinite(reportedInputTokens) || reportedInputTokens <= 0) return current;
  if (!Number.isFinite(observedChars) || observedChars <= 0) return current;
  const clamped = clampDensity(observedChars / reportedInputTokens);
  if (samples <= 0) return clamped;
  return current * (1 - CALIBRATION_EMA_ALPHA) + clamped * CALIBRATION_EMA_ALPHA;
}

/** True once enough real samples have been observed to trust the calibration. */
export function isCalibrated(samples: number): boolean {
  return samples >= MIN_CALIBRATION_SAMPLES;
}

/**
 * Smallest number of oldest messages to drop so the KEPT tail is estimated to
 * fit under COMPRESSION_TARGET_FRACTION of the effective token limit. Adapts to
 * measured density: dense (low chars/token) sessions yield a larger count.
 */
export function messagesToFitTokenTarget(
  messageLengths: number[],
  effectiveLimit: number,
  charsPerToken: number,
  calibrated: boolean,
): number {
  const target = Math.floor(effectiveLimit * COMPRESSION_TARGET_FRACTION);
  if (target <= 0) return 0;

  const perMessageTokens = messageLengths.map((len) => estimateTokens(len, charsPerToken, calibrated));
  let keptTokens = perMessageTokens.reduce((sum, t) => sum + t, 0);

  let drop = 0;
  while (drop < messageLengths.length && keptTokens > target) {
    keptTokens -= perMessageTokens[drop];
    drop++;
  }
  return drop;
}

// ── Compression decision ─────────────────────────────────────
// Hard ceilings that trigger a compression pass. Exported so callers and
// tests reference one source of truth rather than re-deriving the numbers.
export const CONTEXT_TOKEN_LIMIT = 150_000;
export const RESPONSE_TOKEN_BUFFER = 8192; // headroom reserved for the model's reply
export const MAX_HISTORY_MESSAGES = 120;

export interface CompressionPlan {
  /** Number of oldest messages to compress/drop (always >= 2 when present). */
  messagesToCompress: number;
  /** Human-readable trigger, surfaced to the user. */
  reason: string;
}

/**
 * Decide whether the history needs compressing and, if so, how many of the
 * oldest messages to fold away. Returns null when no compression is needed.
 *
 * This is the pure decision lifted out of ChatSession.enforceContextWindowGuard;
 * the caller still owns the effectful part (summarizing via the model and
 * mutating history). Three lower bounds are combined and the largest wins:
 *   a) the original 60% floor (never compress less than before),
 *   b) enough to satisfy the message cap, and
 *   c) enough that the kept tail is estimated to sit under the target fraction
 *      of the effective limit — so a token-dense session sheds more in one pass
 *      instead of re-compressing on the very next turn.
 * At least the most recent turn is always kept, and a plan of fewer than two
 * messages is treated as not worth a compression round trip.
 */
export function planContextCompression(
  messageLengths: number[],
  systemPromptLength: number,
  charsPerToken: number,
  calibrated: boolean,
): CompressionPlan | null {
  const messageCount = messageLengths.length;
  const historyLength = messageLengths.reduce((sum, len) => sum + len, 0);

  const historyTokens = estimateTokens(historyLength, charsPerToken, calibrated);
  const systemPromptTokens = estimateTokens(systemPromptLength, charsPerToken, calibrated);
  const effectiveLimit = CONTEXT_TOKEN_LIMIT - systemPromptTokens - RESPONSE_TOKEN_BUFFER;

  const overTokenLimit = historyTokens > effectiveLimit;
  const overMessageLimit = messageCount > MAX_HISTORY_MESSAGES;

  if (!overTokenLimit && !overMessageLimit) return null;

  const messagesToCompress = Math.min(
    messageCount - 1, // always keep at least the most recent turn
    Math.max(
      Math.floor(messageCount * MIN_COMPRESSION_FRACTION),
      messageCount - (MAX_HISTORY_MESSAGES - 1),
      messagesToFitTokenTarget(messageLengths, effectiveLimit, charsPerToken, calibrated),
    ),
  );

  if (messagesToCompress < 2) return null;

  const reason = overMessageLimit ? `message cap (> ${MAX_HISTORY_MESSAGES})` : '150k token limit';
  return { messagesToCompress, reason };
}
