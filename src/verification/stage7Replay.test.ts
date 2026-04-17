/**
 * Stage 7.2 — frozen CSV-equivalent JSON replay: indicators + FSM goldens must match.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { computeBarIndicators } from "../indicators/computeBarIndicators.js";
import type { Ohlcv } from "../strategy/candleSemantics.js";
import { runFsmSeries } from "../strategy/runFsmSeries.js";
import { DEFAULT_STRATEGY_CONFIG } from "../strategy/strategyConfig.js";
import type { StrategyEvent } from "../strategy/types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = join(__dirname, "..", "..", "fixtures", "stage7");

function loadJson<T>(name: string): T {
  const raw = readFileSync(join(FIXTURE_DIR, name), "utf8");
  return JSON.parse(raw) as T;
}

/** JSON stores `NaN` as `null` — treat both as non-finite match. */
function expectCloseOrGoldenNaN(computed: number, golden: number | null): void {
  if (golden === null) {
    expect(Number.isNaN(computed)).toBe(true);
    return;
  }
  expect(computed).toBeCloseTo(golden, 9);
}

describe("Stage 7.2 replay fixtures", () => {
  it("recomputes indicators matching indicators.golden.json", () => {
    const bars = loadJson<Ohlcv[]>("replay_bars.json");
    const golden = loadJson<{ vwap: number; vwma3: number | null; vwma9: number | null; vwma18: number | null }[]>(
      "indicators.golden.json",
    );
    const manifest = loadJson<{ barCount: number }>("manifest.json");

    expect(bars.length).toBe(manifest.barCount);
    expect(golden.length).toBe(bars.length);

    const computed = computeBarIndicators(bars, DEFAULT_STRATEGY_CONFIG);
    expect(computed).toHaveLength(golden.length);

    for (let i = 0; i < golden.length; i++) {
      const g = golden[i]!;
      const c = computed[i]!;
      expectCloseOrGoldenNaN(c.vwap, g.vwap);
      expectCloseOrGoldenNaN(c.vwma3, g.vwma3);
      expectCloseOrGoldenNaN(c.vwma9, g.vwma9);
      expectCloseOrGoldenNaN(c.vwma18, g.vwma18);
    }
  });

  it("recomputes FSM events matching fsm_events.golden.json", () => {
    const bars = loadJson<Ohlcv[]>("replay_bars.json");
    const golden = loadJson<StrategyEvent[]>("fsm_events.golden.json");
    const manifest = loadJson<{ finalPhase: string }>("manifest.json");

    const indicators = computeBarIndicators(bars, DEFAULT_STRATEGY_CONFIG);
    const { events, finalState } = runFsmSeries(DEFAULT_STRATEGY_CONFIG, bars, indicators);

    expect(events).toEqual(golden);
    expect(finalState.phase).toBe(manifest.finalPhase);
  });
});
