/**
 * Stage 3.1 — aligned per-bar indicator row (VWAP + triple VWMA per {@link StrategyConfig.vwmaPeriods}).
 */

import type { BarIndicators } from "../strategy/barIndicators.js";
import type { Ohlcv } from "../strategy/candleSemantics.js";
import type { StrategyConfig } from "../strategy/strategyConfig.js";
import { computeVwapSeries } from "./vwap.js";
import { computeVwmaSeries } from "./vwma.js";

export function computeBarIndicators(bars: readonly Ohlcv[], strategy: StrategyConfig): BarIndicators[] {
  if (bars.length === 0) {
    return [];
  }
  const closes = bars.map((b) => b.close);
  const volumes = bars.map((b) => b.volume);
  const vwap = computeVwapSeries(bars, strategy.vwap);
  const { fast, mid, slow } = strategy.vwmaPeriods;
  const vwma3 = computeVwmaSeries(closes, volumes, fast);
  const vwma9 = computeVwmaSeries(closes, volumes, mid);
  const vwma18 = computeVwmaSeries(closes, volumes, slow);
  const n = bars.length;
  const out: BarIndicators[] = [];
  for (let i = 0; i < n; i++) {
    out.push({
      vwap: vwap[i]!,
      vwma3: vwma3[i]!,
      vwma9: vwma9[i]!,
      vwma18: vwma18[i]!,
    });
  }
  return out;
}
