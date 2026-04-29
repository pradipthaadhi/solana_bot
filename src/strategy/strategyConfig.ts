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

/**
 * Three VWMA lengths: fast & mid drive entry/arm/invalidate crosses; mid & slow drive exit.
 * Stored in {@link BarIndicators} as vwma3 / vwma9 / vwma18 slots (legacy names; values follow these periods).
 */
export interface VwmaPeriodTriple {
  fast: number;
  mid: number;
  slow: number;
}

/** Repo default: fast/mid for bullish arm & bear invalidation; mid/slow for exit (classic 3/9/18 desk). */
export const DEFAULT_VWMA_PERIODS: VwmaPeriodTriple = { fast: 3, mid: 9, slow: 18 };

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
  /** VWMA window lengths; must satisfy `fast < mid < slow`. */
  vwmaPeriods: VwmaPeriodTriple;
}

/** Canonical v1 from the staged document: strict close vs VWAP on cross bar + two green confirmation. */
export const DEFAULT_STRATEGY_CONFIG: StrategyConfig = {
  vwap: "UTC_DAY",
  belowVwap: "CLOSE",
  entryConfirm: "TWO_GREEN_ABOVE_VWAP",
  volumeZero: "SKIP_SIGNALS",
  invalidateArmedOnBearish3_9: true,
  vwmaPeriods: DEFAULT_VWMA_PERIODS,
};

const VWMA_PERIOD_MAX = 500;

export function assertValidStrategyConfig(config: StrategyConfig): void {
  if (typeof config.vwap === "object" && config.vwap.kind === "ROLLING_N" && config.vwap.bars < 1) {
    throw new Error("ROLLING_N requires bars >= 1");
  }
  const { fast, mid, slow } = config.vwmaPeriods;
  for (const [label, n] of [
    ["fast", fast],
    ["mid", mid],
    ["slow", slow],
  ] as const) {
    if (!Number.isInteger(n) || n < 1) {
      throw new Error(`vwmaPeriods.${label} must be an integer >= 1`);
    }
    if (n > VWMA_PERIOD_MAX) {
      throw new Error(`vwmaPeriods.${label} must be <= ${VWMA_PERIOD_MAX}`);
    }
  }
  if (!(fast < mid && mid < slow)) {
    throw new Error("vwmaPeriods must satisfy fast < mid < slow");
  }
}

/** Upper bound for user-configurable VWMA lengths (chart desk + `assertValidStrategyConfig`). */
export const MAX_VWMA_PERIOD = VWMA_PERIOD_MAX;
