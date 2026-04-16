import { describe, expect, it } from "vitest";
import { computeBarIndicators } from "../indicators/computeBarIndicators.js";
import type { Ohlcv } from "./candleSemantics.js";
import { runFsmSeries } from "./runFsmSeries.js";
import { DEFAULT_STRATEGY_CONFIG, type StrategyConfig } from "./strategyConfig.js";

function oc(close: number, timeMs: number, volume = 1): Ohlcv {
  return { open: close, high: close, low: close, close, volume, timeMs };
}

describe("Indicators + FSM integration (Stages 3–4)", () => {
  it("runs computeBarIndicators → runFsmSeries end-to-end on a longer window (warm VWMA periods)", () => {
    const t0 = Date.UTC(2026, 3, 16, 0, 0, 0);
    const bars: Ohlcv[] = Array.from({ length: 40 }, (_, i) => oc(50 + i, t0 + i * 3600_000));

    const strat: StrategyConfig = {
      ...DEFAULT_STRATEGY_CONFIG,
      vwap: { kind: "ROLLING_N", bars: 10_000 },
    };

    const indicators = computeBarIndicators(bars, strat);
    expect(indicators).toHaveLength(bars.length);

    const last = indicators[indicators.length - 1]!;
    expect(Number.isFinite(last.vwap)).toBe(true);
    expect(Number.isFinite(last.vwma3)).toBe(true);
    expect(Number.isFinite(last.vwma9)).toBe(true);
    expect(Number.isFinite(last.vwma18)).toBe(true);

    const { events, finalState } = runFsmSeries(strat, bars, indicators);
    expect(Array.isArray(events)).toBe(true);
    expect(["FLAT", "ARMED", "LONG"]).toContain(finalState.phase);
  });
});
