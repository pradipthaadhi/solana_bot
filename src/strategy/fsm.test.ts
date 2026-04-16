import { describe, expect, it } from "vitest";
import { typicalPrice } from "./candleSemantics.js";
import type { Ohlcv } from "./candleSemantics.js";
import { bear9_18, bull3_9 } from "./crosses.js";
import type { BarIndicators } from "./fsm.js";
import { runFsmSeries } from "./runFsmSeries.js";
import { DEFAULT_STRATEGY_CONFIG, type StrategyConfig } from "./strategyConfig.js";

describe("typicalPrice (Stage 1.1)", () => {
  it("matches hlc3", () => {
    expect(typicalPrice({ high: 5, low: 3, close: 4 })).toBe(4);
  });
});

describe("cross predicates (Stage 1.4 / 3.2)", () => {
  it("detects bullish 3/9 on close", () => {
    expect(bull3_9({ vwma3Prev: 1, vwma3: 3, vwma9Prev: 2, vwma9: 2, vwma18Prev: 4, vwma18: 4 })).toBe(true);
    expect(bull3_9({ vwma3Prev: 3, vwma3: 3, vwma9Prev: 2, vwma9: 2, vwma18Prev: 4, vwma18: 4 })).toBe(false);
  });

  it("detects bearish 9/18 on close", () => {
    expect(bear9_18({ vwma3Prev: 3, vwma3: 3, vwma9Prev: 5, vwma9: 3, vwma18Prev: 4, vwma18: 4 })).toBe(true);
  });
});

function bar(o: number, h: number, l: number, c: number, t: number): Ohlcv {
  return { open: o, high: h, low: l, close: c, volume: 1, timeMs: t };
}

describe("runFsmSeries (Stage 1.5)", () => {
  it("FLAT → ARMED → LONG → FLAT on synthetic indicators (default v1)", () => {
    const bars: Ohlcv[] = [
      bar(1, 2, 1, 1, 1_000),
      bar(1, 2, 1, 1, 2_000),
      bar(1, 6, 1, 5, 3_000), // cross bar: close < vwap(10)
      bar(7, 10, 6, 9, 4_000), // first green above vwap
      bar(8, 11, 7, 10, 5_000), // second green above vwap → entry
      bar(8, 11, 7, 10, 6_000), // exit cross on vwma9/18
    ];

    const indicators: BarIndicators[] = [
      { vwap: 10, vwma3: 1, vwma9: 2, vwma18: 4 },
      { vwap: 10, vwma3: 1, vwma9: 2, vwma18: 4 },
      { vwap: 10, vwma3: 3, vwma9: 2, vwma18: 4 }, // bull 3/9, below VWAP
      { vwap: 8, vwma3: 4, vwma9: 3, vwma18: 4 }, // stay bullish 3>9 while confirming
      { vwap: 8, vwma3: 5, vwma9: 4, vwma18: 4 }, // still 3>9; two green candles handle entry
      { vwap: 8, vwma3: 5, vwma9: 3, vwma18: 4 }, // bear 9/18 exit
    ];

    const { events, finalState } = runFsmSeries(DEFAULT_STRATEGY_CONFIG, bars, indicators);

    expect(events.map((e) => e.kind)).toEqual(["SIGNAL_ARMED", "SIGNAL_ENTRY", "SIGNAL_EXIT"]);
    expect(events[0]?.barIndex).toBe(2);
    expect(events[1]?.barIndex).toBe(4);
    expect(events[2]?.barIndex).toBe(5);
    expect(finalState).toEqual({ phase: "FLAT" });
  });

  it("honors SINGLE_CLOSE_ABOVE_VWAP confirmation", () => {
    const config: StrategyConfig = {
      ...DEFAULT_STRATEGY_CONFIG,
      entryConfirm: "SINGLE_CLOSE_ABOVE_VWAP",
    };
    const bars: Ohlcv[] = [
      bar(1, 2, 1, 1, 1_000),
      bar(1, 2, 1, 1, 2_000),
      bar(1, 6, 1, 5, 3_000),
      bar(7, 10, 6, 9, 4_000), // first bar after cross with close > vwap → entry here
    ];
    const indicators: BarIndicators[] = [
      { vwap: 10, vwma3: 1, vwma9: 2, vwma18: 4 },
      { vwap: 10, vwma3: 1, vwma9: 2, vwma18: 4 },
      { vwap: 10, vwma3: 3, vwma9: 2, vwma18: 4 },
      { vwap: 8, vwma3: 3, vwma9: 2, vwma18: 4 },
    ];
    const { events } = runFsmSeries(config, bars, indicators);
    expect(events.map((e) => e.kind)).toEqual(["SIGNAL_ARMED", "SIGNAL_ENTRY"]);
    expect(events[1]?.barIndex).toBe(3);
  });

  it("invalidates ARMED on bearish 3/9 when enabled", () => {
    const bars: Ohlcv[] = [
      bar(1, 2, 1, 1, 1_000),
      bar(1, 2, 1, 1, 2_000),
      bar(1, 6, 1, 5, 3_000),
      bar(1, 2, 1, 1, 4_000),
    ];
    const indicators: BarIndicators[] = [
      { vwap: 10, vwma3: 1, vwma9: 2, vwma18: 4 },
      { vwap: 10, vwma3: 1, vwma9: 2, vwma18: 4 },
      { vwap: 10, vwma3: 3, vwma9: 2, vwma18: 4 },
      { vwap: 10, vwma3: 1, vwma9: 3, vwma18: 4 }, // bear 3/9 vs previous
    ];
    const { events, finalState } = runFsmSeries(DEFAULT_STRATEGY_CONFIG, bars, indicators);
    expect(events.map((e) => e.kind)).toEqual(["SIGNAL_ARMED", "INVALIDATED"]);
    expect(finalState.phase).toBe("FLAT");
  });

  it("uses TYPICAL_PRICE for below-VWAP on the cross bar when configured", () => {
    const config: StrategyConfig = {
      ...DEFAULT_STRATEGY_CONFIG,
      belowVwap: "TYPICAL_PRICE",
      entryConfirm: "SINGLE_CLOSE_ABOVE_VWAP",
    };
    // Close above VWAP, but hlc3 below VWAP — only TYPICAL_PRICE arms.
    const bars: Ohlcv[] = [
      bar(1, 2, 1, 1, 1_000),
      bar(1, 2, 1, 1, 2_000),
      bar(10, 12, 2, 11, 3_000), // tp = 8.333..., vwap 10 → below; close 11 > 10
      bar(1, 12, 1, 11, 4_000), // confirm close > vwap(10)
    ];
    const indicators: BarIndicators[] = [
      { vwap: 10, vwma3: 1, vwma9: 2, vwma18: 4 },
      { vwap: 10, vwma3: 1, vwma9: 2, vwma18: 4 },
      { vwap: 10, vwma3: 3, vwma9: 2, vwma18: 4 },
      { vwap: 10, vwma3: 3, vwma9: 2, vwma18: 4 },
    ];
    const { events } = runFsmSeries(config, bars, indicators);
    expect(events.map((e) => e.kind)).toEqual(["SIGNAL_ARMED", "SIGNAL_ENTRY"]);
  });

  it("does not arm from FLAT when indicator rows are non-finite", () => {
    const bars: Ohlcv[] = [
      bar(1, 2, 1, 1, 1_000),
      bar(1, 2, 1, 1, 2_000),
    ];
    const indicators: BarIndicators[] = [
      { vwap: 10, vwma3: 1, vwma9: 2, vwma18: 4 },
      { vwap: Number.NaN, vwma3: 3, vwma9: 2, vwma18: 4 },
    ];
    const { events } = runFsmSeries(DEFAULT_STRATEGY_CONFIG, bars, indicators);
    expect(events).toHaveLength(0);
  });

  it("skips processing when volume is zero and policy is SKIP_SIGNALS", () => {
    const bars: Ohlcv[] = [
      { open: 1, high: 2, low: 1, close: 1, volume: 0, timeMs: 1_000 },
      { open: 1, high: 2, low: 1, close: 1, volume: 0, timeMs: 2_000 },
    ];
    const indicators: BarIndicators[] = [
      { vwap: 10, vwma3: 1, vwma9: 2, vwma18: 4 },
      { vwap: 10, vwma3: 3, vwma9: 2, vwma18: 4 },
    ];
    const { events } = runFsmSeries(DEFAULT_STRATEGY_CONFIG, bars, indicators);
    expect(events).toHaveLength(0);
  });
});
