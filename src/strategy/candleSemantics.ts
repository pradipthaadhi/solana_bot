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
  /** Unix ms at candle close (CoinGecko OHLC uses close time). */
  timeMs: number;
}

export function typicalPrice(bar: Pick<Ohlcv, "high" | "low" | "close">): number {
  return (bar.high + bar.low + bar.close) / 3;
}
