/**
 * Chart viewport helpers — clip OHLCV + aligned indicator rows for UI without changing strategy inputs.
 */

import type { BarIndicators } from "../strategy/barIndicators.js";
import type { Ohlcv } from "../strategy/candleSemantics.js";

/** Default trailing window for 1m charts: 2 hours of candles. */
export const CHART_DISPLAY_WINDOW_MS_DEFAULT = 2 * 60 * 60 * 1000;

/**
 * Returns parallel slices of `bars` and `indicators` whose `timeMs` lies in
 * `(lastBar.timeMs - windowMs, lastBar.timeMs]` — left edge **exclusive** so that
 * for evenly spaced 1m bars, a 2h window yields 120 candles (not 121).
 */
export function sliceOhlcvSeriesForTrailingWindow(
  bars: readonly Ohlcv[],
  indicators: readonly BarIndicators[],
  windowMs: number,
): { viewBars: Ohlcv[]; viewIndicators: BarIndicators[] } {
  if (bars.length === 0) {
    return { viewBars: [], viewIndicators: [] };
  }
  if (bars.length !== indicators.length) {
    throw new Error("bars and indicators must have the same length");
  }
  const lastT = bars[bars.length - 1]!.timeMs;
  const cutoff = lastT - windowMs;
  let start = 0;
  for (; start < bars.length; start++) {
    if (bars[start]!.timeMs > cutoff) {
      break;
    }
  }
  return {
    viewBars: bars.slice(start),
    viewIndicators: indicators.slice(start),
  };
}
