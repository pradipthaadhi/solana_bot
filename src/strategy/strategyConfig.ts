/**
 * Stage 1.3–1.4 — pinned VWAP mode and v1 entry/exit confirmation switches.
 * @see docs/STANDALONE_TRADING_POC_STAGES.md §1.3–1.4
 */

/** VWAP reset policy (must stay explicit for reproducibility). */
export type VwapMode =
  /** Resets cumulative VWAP at each UTC calendar day boundary (00:00:00.000 UTC). */
  | "UTC_DAY"
  /** Cumulative VWAP over the last N bars in the active window (not TV session VWAP). */
  | { kind: "ROLLING_N"; bars: number }
  /** Cumulative VWAP from the first bar with timeMs >= anchorTimeMs in the window. */
  | { kind: "ANCHOR_MS"; anchorTimeMs: number };

/** How we test “below VWAP” on the bullish 3/9 cross bar. */
export type BelowVwapRule = "CLOSE" | "TYPICAL_PRICE";

/** How we confirm VWAP reclaim after the cross (Stage 1.4). */
export type EntryConfirmMode =
  /** Two consecutive closes above VWAP with bullish candles (close > open). */
  | "TWO_GREEN_ABOVE_VWAP"
  /** First later bar with close > VWAP. */
  | "SINGLE_CLOSE_ABOVE_VWAP";

/** If sum(volume)==0 in a window, skip signal evaluation on that bar (Stage 1.2 footnote). */
export type VolumeZeroPolicy = "SKIP_SIGNALS";

export interface StrategyConfig {
  vwap: VwapMode;
  belowVwap: BelowVwapRule;
  entryConfirm: EntryConfirmMode;
  volumeZero: VolumeZeroPolicy;
  /**
   * While ARMED, return to FLAT if VWMA(3) crosses back below VWMA(9) before confirmation.
   * (Optional invalidation from the state diagram; enabled by default for a sensible POC.)
   */
  invalidateArmedOnBearish3_9: boolean;
}

/** Canonical v1 from the staged document: strict close vs VWAP on cross bar + two green confirmation. */
export const DEFAULT_STRATEGY_CONFIG: StrategyConfig = {
  vwap: "UTC_DAY",
  belowVwap: "CLOSE",
  entryConfirm: "TWO_GREEN_ABOVE_VWAP",
  volumeZero: "SKIP_SIGNALS",
  invalidateArmedOnBearish3_9: true,
};

export function assertValidStrategyConfig(config: StrategyConfig): void {
  if (typeof config.vwap === "object" && config.vwap.kind === "ROLLING_N" && config.vwap.bars < 1) {
    throw new Error("ROLLING_N requires bars >= 1");
  }
}
