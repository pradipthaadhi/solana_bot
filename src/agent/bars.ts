import type { Ohlcv } from "../strategy/candleSemantics.js";

/** Sort by candle close time ascending; collapse duplicate timestamps by keeping the last row. */
export function normalizeBarsAscending(bars: readonly Ohlcv[]): Ohlcv[] {
  const byCloseTime = new Map<number, Ohlcv>();
  for (const b of bars) {
    byCloseTime.set(b.timeMs, b);
  }
  return [...byCloseTime.entries()].sort((a, b) => a[0] - b[0]).map(([, row]) => row);
}
