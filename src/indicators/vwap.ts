/**
 * Stage 1.3 / 3.1 — VWAP from typical price (hlc3) and per-bar volume.
 * @see docs/STANDALONE_TRADING_POC_STAGES.md §1.1, §1.3
 */

import type { Ohlcv } from "../strategy/candleSemantics.js";
import { typicalPrice } from "../strategy/candleSemantics.js";
import type { VwapMode } from "../strategy/strategyConfig.js";
import { utcDayKeyUtc } from "./timeUtc.js";

export function computeVwapSeries(bars: readonly Ohlcv[], mode: VwapMode): number[] {
  const n = bars.length;
  const out = new Array<number>(n);

  if (mode === "UTC_DAY") {
    let currentDay = "";
    let cumTpV = 0;
    let cumV = 0;
    for (let i = 0; i < n; i++) {
      const b = bars[i]!;
      const day = utcDayKeyUtc(b.timeMs);
      if (day !== currentDay) {
        currentDay = day;
        cumTpV = 0;
        cumV = 0;
      }
      const tp = typicalPrice(b);
      cumTpV += tp * b.volume;
      cumV += b.volume;
      out[i] = cumV > 0 ? cumTpV / cumV : Number.NaN;
    }
    return out;
  }

  if (mode.kind === "ROLLING_N") {
    const N = mode.bars;
    for (let i = 0; i < n; i++) {
      const start = Math.max(0, i - N + 1);
      let cumTpV = 0;
      let cumV = 0;
      for (let k = start; k <= i; k++) {
        const b = bars[k]!;
        cumTpV += typicalPrice(b) * b.volume;
        cumV += b.volume;
      }
      out[i] = cumV > 0 ? cumTpV / cumV : Number.NaN;
    }
    return out;
  }

  const anchorMs = mode.anchorTimeMs;
  let active = false;
  let cumTpV = 0;
  let cumV = 0;
  for (let i = 0; i < n; i++) {
    const b = bars[i]!;
    if (!active) {
      if (b.timeMs < anchorMs) {
        out[i] = Number.NaN;
        continue;
      }
      active = true;
      cumTpV = 0;
      cumV = 0;
    }
    cumTpV += typicalPrice(b) * b.volume;
    cumV += b.volume;
    out[i] = cumV > 0 ? cumTpV / cumV : Number.NaN;
  }
  return out;
}
