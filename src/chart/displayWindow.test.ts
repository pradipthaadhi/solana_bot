import { describe, expect, it } from "vitest";
import type { BarIndicators } from "../strategy/barIndicators.js";
import type { Ohlcv } from "../strategy/candleSemantics.js";
import { CHART_DISPLAY_WINDOW_MS_DEFAULT, sliceOhlcvSeriesForTrailingWindow } from "./displayWindow.js";

function oc(close: number, timeMs: number): Ohlcv {
  return { open: close, high: close, low: close, close, volume: 1, timeMs };
}

function ind(v: number): BarIndicators {
  return { vwap: v, vwma3: v, vwma9: v, vwma18: v };
}

describe("sliceOhlcvSeriesForTrailingWindow", () => {
  it("keeps only rows within the trailing window from the last bar", () => {
    const tEnd = Date.UTC(2026, 3, 17, 12, 0, 0);
    const bars: Ohlcv[] = [];
    const indicators: BarIndicators[] = [];
    for (let i = 0; i < 200; i++) {
      bars.push(oc(100 + i, tEnd - (199 - i) * 60_000));
      indicators.push(ind(i));
    }
    const { viewBars, viewIndicators } = sliceOhlcvSeriesForTrailingWindow(
      bars,
      indicators,
      CHART_DISPLAY_WINDOW_MS_DEFAULT,
    );
    expect(viewBars.length).toBe(120);
    expect(viewIndicators.length).toBe(120);
    expect(viewBars[0]!.timeMs).toBe(tEnd - 119 * 60_000);
    expect(viewBars[119]!.timeMs).toBe(tEnd);
  });

  it("returns all rows when the series is shorter than the window", () => {
    const bars: Ohlcv[] = [oc(1, 1000), oc(2, 1060)];
    const indicators: BarIndicators[] = [ind(0), ind(1)];
    const { viewBars, viewIndicators } = sliceOhlcvSeriesForTrailingWindow(bars, indicators, CHART_DISPLAY_WINDOW_MS_DEFAULT);
    expect(viewBars).toEqual(bars);
    expect(viewIndicators).toEqual(indicators);
  });
});
