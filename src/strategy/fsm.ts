/**
 * Stage 1.4–1.5 — formal entry/exit FSM (single long, closed bars).
 * @see docs/STANDALONE_TRADING_POC_STAGES.md §1.4–1.5
 */

import type { BarIndicators } from "./barIndicators.js";
import { indicatorsRowFinite } from "./barIndicators.js";
import { typicalPrice, type Ohlcv } from "./candleSemantics.js";
import { bear3_9, bear9_18, bull3_9, type CrossSeriesSlice } from "./crosses.js";
import type { StrategyConfig } from "./strategyConfig.js";
import type { FsmState, StrategyEvent } from "./types.js";

export type { BarIndicators } from "./barIndicators.js";

export interface FsmStepInput {
  config: StrategyConfig;
  state: FsmState;
  index: number;
  bar: Ohlcv;
  ind: BarIndicators;
  prevInd: BarIndicators | undefined;
}

function sliceFromPrev(curr: BarIndicators, prev: BarIndicators): CrossSeriesSlice {
  return {
    vwma3Prev: prev.vwma3,
    vwma3: curr.vwma3,
    vwma9Prev: prev.vwma9,
    vwma9: curr.vwma9,
    vwma18Prev: prev.vwma18,
    vwma18: curr.vwma18,
  };
}

function longExitEventIfAny(
  prevInd: BarIndicators | undefined,
  ind: BarIndicators,
  index: number,
): StrategyEvent | undefined {
  if (prevInd === undefined) {
    return undefined;
  }
  const x = sliceFromPrev(ind, prevInd);
  if (!bear9_18(x)) {
    return undefined;
  }
  return {
    kind: "SIGNAL_EXIT",
    barIndex: index,
    reason: "bear9_18: VWMA(9) crossed below VWMA(18) on bar close",
  };
}

function belowVwapOnCross(config: StrategyConfig, bar: Ohlcv, vwap: number): boolean {
  if (!Number.isFinite(vwap)) {
    return false;
  }
  if (config.belowVwap === "CLOSE") {
    return bar.close < vwap;
  }
  return typicalPrice(bar) < vwap;
}

function singleCloseAbove(bar: Ohlcv, vwap: number): boolean {
  return bar.close > vwap;
}

function twoGreenAboveVwap(prevBar: Ohlcv, prevVwap: number, bar: Ohlcv, vwap: number): boolean {
  const prevOk = prevBar.close > prevVwap && prevBar.close > prevBar.open;
  const currOk = bar.close > vwap && bar.close > bar.open;
  return prevOk && currOk;
}

function confirmationMet(
  config: StrategyConfig,
  crossIndex: number,
  index: number,
  bars: Ohlcv[],
  vwaps: number[],
): boolean {
  if (index <= crossIndex) {
    return false;
  }
  if (config.entryConfirm === "SINGLE_CLOSE_ABOVE_VWAP") {
    const bar = bars[index];
    const vwap = vwaps[index];
    if (bar === undefined || vwap === undefined || !Number.isFinite(vwap)) {
      return false;
    }
    return singleCloseAbove(bar, vwap);
  }
  // TWO_GREEN requires two bars strictly after crossIndex: first pair ends at index >= crossIndex+2
  if (index < crossIndex + 2) {
    return false;
  }
  const prevBar = bars[index - 1];
  const bar = bars[index];
  const prevVwap = vwaps[index - 1];
  const vwap = vwaps[index];
  if (!prevBar || !bar || prevVwap === undefined || vwap === undefined) {
    return false;
  }
  if (!Number.isFinite(prevVwap) || !Number.isFinite(vwap)) {
    return false;
  }
  return twoGreenAboveVwap(prevBar, prevVwap, bar, vwap);
}

export interface FsmAdvanceContext {
  bars: Ohlcv[];
  vwaps: number[];
}

/**
 * Advance the FSM for bar `input.index` using full series context for confirmation windows.
 * Preconditions: `bars`, indicator arrays aligned; `prevInd` undefined only on first bar (no crosses).
 */
export function advanceFsm(input: FsmStepInput, ctx: FsmAdvanceContext): { state: FsmState; events: StrategyEvent[] } {
  const events: StrategyEvent[] = [];
  const { config, state, index, bar, ind, prevInd } = input;

  if (bar.volume === 0 && config.volumeZero === "SKIP_SIGNALS") {
    // Still allow protective exit while LONG; skip only new entries/arming on zero-volume bars.
    if (state.phase === "LONG") {
      const exitEv = longExitEventIfAny(prevInd, ind, index);
      if (exitEv !== undefined) {
        events.push(exitEv);
        return { state: { phase: "FLAT" }, events };
      }
    }
    return { state, events };
  }

  if ((state.phase === "FLAT" || state.phase === "ARMED") && !indicatorsRowFinite(ind)) {
    return { state, events };
  }

  if (state.phase === "LONG") {
    const exitEv = longExitEventIfAny(prevInd, ind, index);
    if (exitEv !== undefined) {
      events.push(exitEv);
      return { state: { phase: "FLAT" }, events };
    }
    return { state, events };
  }

  if (state.phase === "ARMED") {
    const crossIndex = state.crossIndex;
    if (prevInd !== undefined) {
      const x = sliceFromPrev(ind, prevInd);
      if (config.invalidateArmedOnBearish3_9 && bear3_9(x)) {
        events.push({
          kind: "INVALIDATED",
          barIndex: index,
          reason: "bear3_9 while ARMED: VWMA(3) crossed back below VWMA(9) before entry confirmation",
        });
        return { state: { phase: "FLAT" }, events };
      }
    }
    if (confirmationMet(config, crossIndex, index, ctx.bars, ctx.vwaps)) {
      events.push({
        kind: "SIGNAL_ENTRY",
        barIndex: index,
        reason:
          config.entryConfirm === "TWO_GREEN_ABOVE_VWAP"
            ? "Two consecutive bullish closes above VWAP after bullish 3/9 cross below VWAP"
            : "First close strictly above VWAP after bullish 3/9 cross below VWAP",
      });
      return { state: { phase: "LONG", entryIndex: index }, events };
    }
    return { state, events };
  }

  // FLAT
  if (prevInd === undefined) {
    return { state, events };
  }
  const x = sliceFromPrev(ind, prevInd);
  if (bull3_9(x) && belowVwapOnCross(config, bar, ind.vwap)) {
    events.push({
      kind: "SIGNAL_ARMED",
      barIndex: index,
      reason: "bull3_9 on close while below VWAP (per configured rule on cross bar)",
    });
    return { state: { phase: "ARMED", crossIndex: index }, events };
  }

  return { state, events };
}
