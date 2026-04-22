/**
 * Stage 1.1 — candle semantics (typical price / hlc3 for VWAP alignment with TradingView legend).
 * @see docs/STANDALONE_TRADING_POC_STAGES.md §1.1
 */

export interface Ohlcv {
  open: number;
  high: number;
  low: number;
  close: number;
  /** Per-bar volume; may be synthesized (e.g. 1) until Stage 2 merges real volumes. */
  volume: number;
  /** Bar id as Unix ms (GeckoTerminal 1m OHLCV uses **bucket open** UTC = `timestamp_sec * 1000`; strategy still evaluates one closed bar per row in time order). */
  timeMs: number;
}

export function typicalPrice(bar: Pick<Ohlcv, "high" | "low" | "close">): number {
  return (bar.high + bar.low + bar.close) / 3;
}
