/**
 * Stage 1 / 3.2 — closed-bar cross predicates (no repainting).
 * @see docs/STANDALONE_TRADING_POC_STAGES.md §1.4, §3.2
 */

export interface CrossSeriesSlice {
  vwma3Prev: number;
  vwma3: number;
  vwma9Prev: number;
  vwma9: number;
  vwma18Prev: number;
  vwma18: number;
}

function allFinite6(s: CrossSeriesSlice): boolean {
  return (
    Number.isFinite(s.vwma3Prev) &&
    Number.isFinite(s.vwma3) &&
    Number.isFinite(s.vwma9Prev) &&
    Number.isFinite(s.vwma9) &&
    Number.isFinite(s.vwma18Prev) &&
    Number.isFinite(s.vwma18)
  );
}

/** Bullish VWMA(3) cross above VWMA(9) on the bar close. */
export function bull3_9(s: CrossSeriesSlice): boolean {
  if (!allFinite6(s)) {
    return false;
  }
  return s.vwma3Prev <= s.vwma9Prev && s.vwma3 > s.vwma9;
}

/** Bearish VWMA(9) cross below VWMA(18) on the bar close (exit trigger). */
export function bear9_18(s: CrossSeriesSlice): boolean {
  if (!allFinite6(s)) {
    return false;
  }
  return s.vwma9Prev >= s.vwma18Prev && s.vwma9 < s.vwma18;
}

/** Bearish VWMA(3) cross below VWMA(9) (optional ARMED invalidation). */
export function bear3_9(s: CrossSeriesSlice): boolean {
  if (!allFinite6(s)) {
    return false;
  }
  return s.vwma3Prev >= s.vwma9Prev && s.vwma3 < s.vwma9;
}
