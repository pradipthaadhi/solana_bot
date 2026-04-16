import { describe, expect, it } from "vitest";
import { computeBarIndicators } from "./computeBarIndicators.js";
import { utcDayKeyUtc } from "./timeUtc.js";
import { computeVwapSeries } from "./vwap.js";
import { computeVwmaSeries } from "./vwma.js";
import type { Ohlcv } from "../strategy/candleSemantics.js";
import { DEFAULT_STRATEGY_CONFIG, type StrategyConfig } from "../strategy/strategyConfig.js";

function ohlc(o: number, h: number, l: number, c: number, v: number, timeMs: number): Ohlcv {
  return { open: o, high: h, low: l, close: c, volume: v, timeMs };
}

/** hlc3 == close (simplifies VWAP expectations in unit tests). */
function oc(close: number, timeMs: number, volume = 1): Ohlcv {
  return { open: close, high: close, low: close, close, volume, timeMs };
}

describe("computeVwmaSeries (Stage 3.1)", () => {
  it("matches SMA of close when volume is constant (1)", () => {
    const closes = [10, 20, 30, 40];
    const vol = [1, 1, 1, 1];
    expect(computeVwmaSeries(closes, vol, 3)).toEqual([Number.NaN, Number.NaN, 20, 30]);
  });

  it("returns NaN when the rolling volume sum is zero", () => {
    const closes = [1, 2, 3];
    const vol = [0, 0, 1];
    const out = computeVwmaSeries(closes, vol, 2);
    expect(Number.isNaN(out[0]!)).toBe(true);
    expect(Number.isNaN(out[1]!)).toBe(true);
    expect(out[2]).toBe(3);
  });
});

describe("computeVwapSeries (Stage 3.1)", () => {
  it("weights typical price (hlc3), not close alone", () => {
    const bars: Ohlcv[] = [ohlc(0, 20, 0, 10, 1, 1_000)];
    const vwap = computeVwapSeries(bars, { kind: "ROLLING_N", bars: 1 });
    expect(vwap[0]).toBeCloseTo((0 + 20 + 10) / 3);
  });

  it("resets on UTC calendar day boundaries", () => {
    const day1 = Date.UTC(2026, 3, 16, 10, 0, 0);
    const day2 = Date.UTC(2026, 3, 17, 10, 0, 0);
    const bars: Ohlcv[] = [oc(10, day1), oc(30, day1 + 3600_000), oc(200, day2)];
    const vwap = computeVwapSeries(bars, "UTC_DAY");
    expect(vwap[0]).toBeCloseTo(10);
    expect(vwap[1]).toBeCloseTo(20);
    expect(vwap[2]).toBeCloseTo(200);
  });

  it("supports ROLLING_N windows", () => {
    const bars: Ohlcv[] = [oc(10, 1_000), oc(30, 2_000), oc(20, 3_000)];
    const vwap = computeVwapSeries(bars, { kind: "ROLLING_N", bars: 2 });
    expect(vwap[0]).toBeCloseTo(10);
    expect(vwap[1]).toBeCloseTo(20);
    expect(vwap[2]).toBeCloseTo(25);
  });

  it("supports ANCHOR_MS (NaN before anchor, cumulative after)", () => {
    const bars: Ohlcv[] = [oc(10, 1000), oc(30, 2000), oc(20, 3000)];
    const vwap = computeVwapSeries(bars, { kind: "ANCHOR_MS", anchorTimeMs: 2000 });
    expect(Number.isNaN(vwap[0]!)).toBe(true);
    expect(vwap[1]).toBeCloseTo(30);
    expect(vwap[2]).toBeCloseTo(25);
  });
});

describe("utcDayKeyUtc", () => {
  it("is stable for regression snapshots", () => {
    expect(utcDayKeyUtc(Date.UTC(2026, 3, 16, 0, 0, 0))).toBe("2026-04-16");
  });
});

describe("computeBarIndicators (Stage 3.1)", () => {
  it("returns aligned rows with the same length as input", () => {
    const bars: Ohlcv[] = Array.from({ length: 20 }, (_, i) =>
      ohlc(i + 1, i + 2, i, i + 1, 1, Date.UTC(2026, 3, 16, i, 0, 0)),
    );
    const ind = computeBarIndicators(bars, DEFAULT_STRATEGY_CONFIG);
    expect(ind).toHaveLength(bars.length);
    expect(ind[18]?.vwma18).toBeDefined();
    expect(Number.isFinite(ind[18]!.vwma18)).toBe(true);
  });

  it("honors custom VWAP mode from strategy config", () => {
    const bars: Ohlcv[] = [oc(10, 1_000), oc(30, 2_000)];
    const strat: StrategyConfig = { ...DEFAULT_STRATEGY_CONFIG, vwap: { kind: "ROLLING_N", bars: 1 } };
    const ind = computeBarIndicators(bars, strat);
    expect(ind[0]?.vwap).toBeCloseTo(10);
    expect(ind[1]?.vwap).toBeCloseTo(30);
  });
});
