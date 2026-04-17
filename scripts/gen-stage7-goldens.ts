/**
 * Regenerates `fixtures/stage7/*.golden.json` from `replay_bars.json` + strategy.
 * Run: `npm run stage7:gen-golden`
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { computeBarIndicators } from "../src/indicators/computeBarIndicators.js";
import type { Ohlcv } from "../src/strategy/candleSemantics.js";
import { runFsmSeries } from "../src/strategy/runFsmSeries.js";
import { DEFAULT_STRATEGY_CONFIG, type StrategyConfig } from "../src/strategy/strategyConfig.js";
import type { StrategyEvent } from "../src/strategy/types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = join(__dirname, "..", "fixtures", "stage7");

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a += 0x6d2b79f5;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Deterministic OHLCV: 1m bars, same UTC day (VWAP UTC_DAY does not reset mid-series). */
function buildReplayBars(): Ohlcv[] {
  const rnd = mulberry32(0x5a7e7_001);
  const t0 = Date.UTC(2026, 2, 15, 8, 0, 0);
  const n = 220;
  const bars: Ohlcv[] = [];
  let c = 48;
  for (let i = 0; i < n; i++) {
    const drift = (rnd() - 0.5) * 1.4;
    const cycle = Math.sin(i * 0.11) * 6 + Math.cos(i * 0.047) * 3;
    c = Math.max(5, c + drift + cycle * 0.02);
    const spread = 0.2 + rnd() * 0.45;
    const o = c + (rnd() - 0.5) * spread;
    const h = Math.max(o, c) + rnd() * spread;
    const l = Math.min(o, c) - rnd() * spread;
    const vol = 400 + Math.floor(rnd() * 900) + i * 2;
    bars.push({
      open: o,
      high: h,
      low: l,
      close: c,
      volume: vol,
      timeMs: t0 + i * 60_000,
    });
  }
  return bars;
}

function round12(x: number): number {
  if (!Number.isFinite(x)) {
    return x;
  }
  return Math.round(x * 1e12) / 1e12;
}

function main(): void {
  mkdirSync(FIXTURE_DIR, { recursive: true });

  const strategy: StrategyConfig = DEFAULT_STRATEGY_CONFIG;
  const bars = buildReplayBars();

  const replayPath = join(FIXTURE_DIR, "replay_bars.json");
  writeFileSync(replayPath, `${JSON.stringify(bars, null, 2)}\n`, "utf8");

  const indicators = computeBarIndicators(bars, strategy);
  const indGolden = indicators.map((row) => ({
    vwap: round12(row.vwap),
    vwma3: round12(row.vwma3),
    vwma9: round12(row.vwma9),
    vwma18: round12(row.vwma18),
  }));
  writeFileSync(join(FIXTURE_DIR, "indicators.golden.json"), `${JSON.stringify(indGolden, null, 2)}\n`, "utf8");

  const { events, finalState } = runFsmSeries(strategy, bars, indicators);
  const evGolden: StrategyEvent[] = events.map((e) => ({
    kind: e.kind,
    barIndex: e.barIndex,
    reason: e.reason,
  }));
  writeFileSync(join(FIXTURE_DIR, "fsm_events.golden.json"), `${JSON.stringify(evGolden, null, 2)}\n`, "utf8");

  const manifest = {
    schemaVersion: 1,
    barCount: bars.length,
    strategy,
    finalPhase: finalState.phase,
    eventCount: events.length,
    generatedBy: "scripts/gen-stage7-goldens.ts",
  };
  writeFileSync(join(FIXTURE_DIR, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  // eslint-disable-next-line no-console
  console.log(`Wrote ${bars.length} bars, ${events.length} events, final ${finalState.phase}`);
}

main();
