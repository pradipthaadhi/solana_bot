import type { Ohlcv } from "./candleSemantics.js";
import { advanceFsm, type BarIndicators } from "./fsm.js";
import type { StrategyConfig } from "./strategyConfig.js";
import type { FsmState, StrategyEvent } from "./types.js";

/**
 * Sequentially apply {@link advanceFsm} across aligned OHLCV + indicator rows (replay helper).
 */
export function runFsmSeries(
  config: StrategyConfig,
  bars: Ohlcv[],
  indicators: BarIndicators[],
): { finalState: FsmState; events: StrategyEvent[] } {
  if (bars.length !== indicators.length) {
    throw new Error("bars and indicators must have the same length");
  }
  let state: FsmState = { phase: "FLAT" };
  const events: StrategyEvent[] = [];
  const vwaps = indicators.map((i) => i.vwap);
  for (let index = 0; index < bars.length; index++) {
    const bar = bars[index];
    const ind = indicators[index];
    if (bar === undefined || ind === undefined) {
      continue;
    }
    const prevInd = index > 0 ? indicators[index - 1] : undefined;
    const step = advanceFsm({ config, state, index, bar, ind, prevInd }, { bars, vwaps });
    state = step.state;
    events.push(...step.events);
  }
  return { finalState: state, events };
}
