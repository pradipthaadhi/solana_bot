/**
 * Stage 7.1 — analytical checks for VWAP / VWMA (TradingView-style hlc3 VWAP uses same typical price as our series).
 * Full bar-by-bar TV parity still requires aligned session + volume source; see `docs/STAGE7_VERIFICATION.md`.
 */

import { describe, expect, it } from "vitest";
import { computeBarIndicators } from "../indicators/computeBarIndicators.js";
import { computeVwapSeries } from "../indicators/vwap.js";
import { computeVwmaSeries } from "../indicators/vwma.js";
import { typicalPrice } from "../strategy/candleSemantics.js";
import type { Ohlcv } from "../strategy/candleSemantics.js";
import { DEFAULT_STRATEGY_CONFIG } from "../strategy/strategyConfig.js";

describe("Stage 7.1 indicator parity (analytical)", () => {
  it("UTC_DAY VWAP equals cumulative sum(typical_price * vol) / sum(vol) within one UTC day", () => {
    const t0 = Date.UTC(2026, 4, 10, 14, 30, 0);
    const bars: Ohlcv[] = [
      { open: 10, high: 12, low: 8, close: 10, volume: 100, timeMs: t0 },
      { open: 10, high: 14, low: 9, close: 11, volume: 200, timeMs: t0 + 60_000 },
      { open: 11, high: 13, low: 10, close: 12, volume: 150, timeMs: t0 + 120_000 },
    ];
    const vwap = computeVwapSeries(bars, "UTC_DAY");
    let cumTpV = 0;
    let cumV = 0;
    for (let i = 0; i < bars.length; i++) {
      const b = bars[i]!;
      cumTpV += typicalPrice(b) * b.volume;
      cumV += b.volume;
      expect(vwap[i]).toBeCloseTo(cumTpV / cumV, 12);
    }
  });

  it("VWMA(3) at bar index 2 matches hand-rolled window", () => {
    const closes = [10, 20, 30];
    const volumes = [1, 2, 3];
    const s = computeVwmaSeries(closes, volumes, 3);
    const manual = (10 * 1 + 20 * 2 + 30 * 3) / (1 + 2 + 3);
    expect(s[2]).toBeCloseTo(manual, 12);
    expect(Number.isNaN(s[0]!)).toBe(true);
    expect(Number.isNaN(s[1]!)).toBe(true);
  });

  it("computeBarIndicators rows align VWAP series and VWMA series on mixed OHLCV", () => {
    const t0 = Date.UTC(2026, 4, 10, 0, 0, 0);
    const bars: Ohlcv[] = Array.from({ length: 25 }, (_, i) => ({
      open: 50 + i * 0.1,
      high: 51 + i * 0.1,
      low: 49 + i * 0.1,
      close: 50.5 + i * 0.1,
      volume: 500 + i * 10,
      timeMs: t0 + i * 60_000,
    }));
    const rows = computeBarIndicators(bars, DEFAULT_STRATEGY_CONFIG);
    const vwap = computeVwapSeries(bars, DEFAULT_STRATEGY_CONFIG.vwap);
    const closes = bars.map((b) => b.close);
    const vols = bars.map((b) => b.volume);
    const v3 = computeVwmaSeries(closes, vols, 3);
    const v9 = computeVwmaSeries(closes, vols, 9);
    const v18 = computeVwmaSeries(closes, vols, 18);
    const closeOrBothNaN = (a: number, b: number) => {
      if (Number.isNaN(a) && Number.isNaN(b)) {
        return;
      }
      expect(a).toBeCloseTo(b, 12);
    };
    for (let i = 0; i < bars.length; i++) {
      closeOrBothNaN(rows[i]!.vwap, vwap[i]!);
      closeOrBothNaN(rows[i]!.vwma3, v3[i]!);
      closeOrBothNaN(rows[i]!.vwma9, v9[i]!);
      closeOrBothNaN(rows[i]!.vwma18, v18[i]!);
    }
  });
});
