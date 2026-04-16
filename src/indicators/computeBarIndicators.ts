/**
 * Stage 3.1 — aligned per-bar indicator row (VWAP + VWMA 3/9/18).
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
  const vwma3 = computeVwmaSeries(closes, volumes, 3);
  const vwma9 = computeVwmaSeries(closes, volumes, 9);
  const vwma18 = computeVwmaSeries(closes, volumes, 18);
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
