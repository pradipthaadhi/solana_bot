import { describe, expect, it, vi } from "vitest";
import { normalizeBarsAscending } from "./bars.js";
import { suggestPollDelayMs } from "./candleClock.js";
import { CapturingExecutionAdapter } from "./executionAdapter.js";
import { SignalAgent, startSignalPolling } from "./signalAgent.js";
import type { BarIndicators } from "../strategy/barIndicators.js";
import type { Ohlcv } from "../strategy/candleSemantics.js";
import { DEFAULT_STRATEGY_CONFIG, type StrategyConfig } from "../strategy/strategyConfig.js";

function bar(o: number, h: number, l: number, c: number, t: number, v = 1): Ohlcv {
  return { open: o, high: h, low: l, close: c, volume: v, timeMs: t };
}

function oc(close: number, timeMs: number, volume = 1): Ohlcv {
  return { open: close, high: close, low: close, close, volume, timeMs };
}

describe("normalizeBarsAscending", () => {
  it("sorts and keeps the last duplicate timestamp", () => {
    const a = bar(1, 1, 1, 1, 100);
    const b = bar(2, 2, 2, 2, 200);
    const b2 = bar(3, 3, 3, 3, 200);
    expect(normalizeBarsAscending([b, a, b2]).map((x) => x.close)).toEqual([1, 3]);
  });
});

describe("suggestPollDelayMs", () => {
  it("clamps suggested delay", () => {
    const d = suggestPollDelayMs({
      lastBarCloseTimeMs: 1_000,
      barDurationMs: 60_000,
      bufferMs: 5_000,
      nowMs: 0,
      minClampMs: 10_000,
      maxClampMs: 15_000,
    });
    expect(d).toBe(15_000);
  });
});

describe("SignalAgent (Stage 4)", () => {
  it("logs ERROR and returns ok=false when fetch throws", async () => {
    const logs: string[] = [];
    const agent = new SignalAgent({
      strategy: DEFAULT_STRATEGY_CONFIG,
      log: (r) => logs.push(r.kind),
    });
    const res = await agent.runTick(async () => {
      throw new Error("network");
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toBe("network");
    }
    expect(logs).toContain("ERROR");
    expect(logs).toContain("TICK_START");
  });

  it("invokes execution hooks only for tail events by default", async () => {
    const cap = new CapturingExecutionAdapter();
    const logs: string[] = [];
    const fixtureIndicators: BarIndicators[] = [
      { vwap: 10, vwma3: 1, vwma9: 2, vwma18: 4 },
      { vwap: 10, vwma3: 1, vwma9: 2, vwma18: 4 },
      { vwap: 10, vwma3: 3, vwma9: 2, vwma18: 4 },
      { vwap: 8, vwma3: 4, vwma9: 3, vwma18: 4 },
      { vwap: 8, vwma3: 5, vwma9: 4, vwma18: 4 },
      { vwap: 8, vwma3: 5, vwma9: 3, vwma18: 4 },
    ];
    const agent = new SignalAgent({
      strategy: DEFAULT_STRATEGY_CONFIG,
      execution: cap,
      executionTailBarLookback: 1,
      computeIndicators: (barsIn) => {
        expect(barsIn.length).toBe(fixtureIndicators.length);
        return fixtureIndicators;
      },
      log: (r) => logs.push(r.kind),
    });

    const bars: Ohlcv[] = [
      bar(1, 2, 1, 1, 1_000),
      bar(1, 2, 1, 1, 2_000),
      bar(1, 6, 1, 5, 3_000),
      bar(7, 10, 6, 9, 4_000),
      bar(8, 11, 7, 10, 5_000),
      bar(8, 11, 7, 10, 6_000),
    ];

    const res = await agent.runTick(async () => bars);
    expect(res.ok).toBe(true);
    if (!res.ok) {
      throw new Error("expected ok tick");
    }

    expect(res.strategyEvents.map((e) => e.kind)).toEqual(["SIGNAL_ARMED", "SIGNAL_ENTRY", "SIGNAL_EXIT"]);
    expect(res.executionHooksApplied.map((e) => e.kind)).toEqual(["SIGNAL_EXIT"]);
    expect(cap.entries).toHaveLength(0);
    expect(cap.exits).toHaveLength(1);
    expect(cap.exits[0]?.barIndex).toBe(5);
    expect(logs).toContain("SIGNAL_ARMED");
    expect(logs).toContain("TICK_OK");
  });

  it("tail_bar_only with executionTailBarLookback includes recent entry + exit", async () => {
    const cap = new CapturingExecutionAdapter();
    const fixtureIndicators: BarIndicators[] = [
      { vwap: 10, vwma3: 1, vwma9: 2, vwma18: 4 },
      { vwap: 10, vwma3: 1, vwma9: 2, vwma18: 4 },
      { vwap: 10, vwma3: 3, vwma9: 2, vwma18: 4 },
      { vwap: 8, vwma3: 4, vwma9: 3, vwma18: 4 },
      { vwap: 8, vwma3: 5, vwma9: 4, vwma18: 4 },
      { vwap: 8, vwma3: 5, vwma9: 3, vwma18: 4 },
    ];
    const agent = new SignalAgent({
      strategy: DEFAULT_STRATEGY_CONFIG,
      execution: cap,
      executionTailBarLookback: 3,
      computeIndicators: (barsIn) => {
        expect(barsIn.length).toBe(fixtureIndicators.length);
        return fixtureIndicators;
      },
      log: () => {},
    });
    const bars: Ohlcv[] = [
      bar(1, 2, 1, 1, 1_000),
      bar(1, 2, 1, 1, 2_000),
      bar(1, 6, 1, 5, 3_000),
      bar(7, 10, 6, 9, 4_000),
      bar(8, 11, 7, 10, 5_000),
      bar(8, 11, 7, 10, 6_000),
    ];
    const res = await agent.runTick(async () => bars);
    expect(res.ok).toBe(true);
    if (!res.ok) {
      throw new Error("expected ok tick");
    }
    expect(res.executionHooksApplied.map((e) => e.kind)).toEqual(["SIGNAL_ENTRY", "SIGNAL_EXIT"]);
    expect(cap.entries).toHaveLength(1);
    expect(cap.exits).toHaveLength(1);
    expect(cap.entries[0]?.barIndex).toBe(4);
    expect(cap.exits[0]?.barIndex).toBe(5);
  });

  it("can invoke execution hooks for the full replay window", async () => {
    const cap = new CapturingExecutionAdapter();
    const fixtureIndicators: BarIndicators[] = [
      { vwap: 10, vwma3: 1, vwma9: 2, vwma18: 4 },
      { vwap: 10, vwma3: 1, vwma9: 2, vwma18: 4 },
      { vwap: 10, vwma3: 3, vwma9: 2, vwma18: 4 },
      { vwap: 8, vwma3: 4, vwma9: 3, vwma18: 4 },
      { vwap: 8, vwma3: 5, vwma9: 4, vwma18: 4 },
      { vwap: 8, vwma3: 5, vwma9: 3, vwma18: 4 },
    ];
    const agent = new SignalAgent({
      strategy: DEFAULT_STRATEGY_CONFIG,
      execution: cap,
      executionHooksScope: "full_window",
      computeIndicators: (barsIn) => {
        expect(barsIn.length).toBe(fixtureIndicators.length);
        return fixtureIndicators;
      },
      log: () => {},
    });
    const bars: Ohlcv[] = [
      bar(1, 2, 1, 1, 1_000),
      bar(1, 2, 1, 1, 2_000),
      bar(1, 6, 1, 5, 3_000),
      bar(7, 10, 6, 9, 4_000),
      bar(8, 11, 7, 10, 5_000),
      bar(8, 11, 7, 10, 6_000),
    ];
    const res = await agent.runTick(async () => bars);
    expect(res.ok).toBe(true);
    if (!res.ok) {
      throw new Error("expected ok tick");
    }
    expect(cap.entries).toHaveLength(1);
    expect(cap.exits).toHaveLength(1);
  });

  it("computes indicators via the default Stage 3 pipeline", async () => {
    const t0 = Date.UTC(2026, 3, 16, 0, 0, 0);
    const bars: Ohlcv[] = Array.from({ length: 25 }, (_, i) => oc(100 + i, t0 + i * 3600_000));
    const strat: StrategyConfig = {
      ...DEFAULT_STRATEGY_CONFIG,
      vwap: { kind: "ROLLING_N", bars: 10_000 },
    };
    const agent = new SignalAgent({ strategy: strat, log: () => {} });
    const res = await agent.runTick(async () => bars);
    expect(res.ok).toBe(true);
    if (!res.ok) {
      throw new Error("expected ok tick");
    }
    expect(res.indicators).toHaveLength(bars.length);
    expect(Number.isFinite(res.indicators[24]!.vwma18)).toBe(true);
  });

  it("emits NOOP when configured and no strategy events fire", async () => {
    const kinds: string[] = [];
    const agent = new SignalAgent({
      strategy: DEFAULT_STRATEGY_CONFIG,
      emitNoop: true,
      log: (r) => kinds.push(r.kind),
    });
    const bars: Ohlcv[] = [bar(1, 2, 1, 1, 1_000)];
    const res = await agent.runTick(async () => bars);
    expect(res.ok).toBe(true);
    expect(kinds).toContain("NOOP");
  });
});

describe("startSignalPolling (Stage 4.2)", () => {
  it("polls without overlapping ticks", async () => {
    vi.useFakeTimers();
    let calls = 0;
    const bars: Ohlcv[] = [bar(1, 2, 1, 1, 1_000)];
    const agent = new SignalAgent({ strategy: DEFAULT_STRATEGY_CONFIG, log: () => {} });
    const handle = startSignalPolling(agent, async () => {
      calls += 1;
      await new Promise((r) => setTimeout(r, 50));
      return bars;
    }, 25);
    await vi.advanceTimersByTimeAsync(80);
    handle.stop();
    vi.useRealTimers();
    expect(calls).toBeGreaterThanOrEqual(1);
  });
});
