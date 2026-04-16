/**
 * Stage 4.2 — conservative polling hint behind closed-bar signals.
 * CoinGecko caches OHLC; this does not replace provider-specific rate limits.
 */

export function clampNumber(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}

/**
 * Suggested delay until the next poll attempt after observing `lastBarCloseTimeMs`.
 * Assumes roughly periodic candles of `barDurationMs` (e.g. 30m for CoinGecko `days=1|2`).
 */
export function suggestPollDelayMs(params: {
  lastBarCloseTimeMs: number;
  barDurationMs: number;
  bufferMs: number;
  nowMs: number;
  minClampMs: number;
  maxClampMs: number;
}): number {
  const { lastBarCloseTimeMs, barDurationMs, bufferMs, nowMs, minClampMs, maxClampMs } = params;
  const nextIdeal = lastBarCloseTimeMs + barDurationMs + bufferMs;
  const raw = Math.max(0, nextIdeal - nowMs);
  return clampNumber(raw, minClampMs, maxClampMs);
}
