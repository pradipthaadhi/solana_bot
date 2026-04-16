/**
 * Stage 4 — single-agent orchestration: fetch → indicators → FSM → structured logs → execution hooks.
 * @see docs/STANDALONE_TRADING_POC_STAGES.md §4
 */

import { normalizeBarsAscending } from "./bars.js";
import type { ExecutionAdapter, ExecutionSignalPayload } from "./executionAdapter.js";
import { NoopExecutionAdapter } from "./executionAdapter.js";
import { computeBarIndicators } from "../indicators/computeBarIndicators.js";
import type { BarIndicators } from "../strategy/barIndicators.js";
import type { Ohlcv } from "../strategy/candleSemantics.js";
import { runFsmSeries } from "../strategy/runFsmSeries.js";
import { assertValidStrategyConfig, type StrategyConfig } from "../strategy/strategyConfig.js";
import type { FsmState, StrategyEvent } from "../strategy/types.js";

export type ExecutionHooksScope = "tail_bar_only" | "full_window";

export type AgentLogKind = StrategyEvent["kind"] | "TICK_START" | "TICK_OK" | "NOOP" | "ERROR";

export interface AgentStructuredRecord {
  tsIso: string;
  kind: AgentLogKind;
  data: Record<string, unknown>;
}

export type ComputeIndicatorsFn = (bars: readonly Ohlcv[], strategy: StrategyConfig) => BarIndicators[];

export interface SignalAgentParams {
  strategy: StrategyConfig;
  /** Override indicator pipeline (used by tests and custom data merges). Defaults to {@link computeBarIndicators}. */
  computeIndicators?: ComputeIndicatorsFn;
  execution?: ExecutionAdapter;
  /**
   * `tail_bar_only` (default): invoke execution hooks only for events on the last bar
   * (rolling-window fetches won't re-fire historical fills each poll).
   */
  executionHooksScope?: ExecutionHooksScope;
  /** Emit a structured NOOP record when a tick produces zero strategy events. */
  emitNoop?: boolean;
  log?: (record: AgentStructuredRecord) => void;
}

function defaultJsonLog(record: AgentStructuredRecord): void {
  globalThis.console?.log(JSON.stringify(record));
}

function randomTickId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export type AgentTickResult =
  | {
      ok: true;
      tickId: string;
      bars: Ohlcv[];
      indicators: BarIndicators[];
      strategyEvents: StrategyEvent[];
      executionHooksApplied: StrategyEvent[];
      finalFsmState: FsmState;
      lastBarCloseTimeMs: number;
    }
  | {
      ok: false;
      tickId: string;
      error: string;
    };

export class SignalAgent {
  private readonly strategy: StrategyConfig;

  private readonly computeIndicators: ComputeIndicatorsFn;

  private readonly execution: ExecutionAdapter;

  private readonly executionHooksScope: ExecutionHooksScope;

  private readonly emitNoop: boolean;

  private readonly log: (record: AgentStructuredRecord) => void;

  constructor(params: SignalAgentParams) {
    assertValidStrategyConfig(params.strategy);
    this.strategy = params.strategy;
    this.computeIndicators = params.computeIndicators ?? computeBarIndicators;
    this.execution = params.execution ?? new NoopExecutionAdapter();
    this.executionHooksScope = params.executionHooksScope ?? "tail_bar_only";
    this.emitNoop = params.emitNoop ?? false;
    this.log = params.log ?? defaultJsonLog;
  }

  async runTick(fetchBars: () => Promise<readonly Ohlcv[] | Ohlcv[]>): Promise<AgentTickResult> {
    const tickId = randomTickId();
    this.log({ tsIso: new Date().toISOString(), kind: "TICK_START", data: { tickId } });
    try {
      const raw = await fetchBars();
      const bars = normalizeBarsAscending(raw);
      if (bars.length === 0) {
        const error = "empty bar series after normalization";
        this.log({ tsIso: new Date().toISOString(), kind: "ERROR", data: { tickId, message: error } });
        return { ok: false, tickId, error };
      }
      const indicators = this.computeIndicators(bars, this.strategy);
      const { events, finalState } = runFsmSeries(this.strategy, bars, indicators);
      const lastIdx = bars.length - 1;
      const lastBar = bars[lastIdx];
      if (lastBar === undefined) {
        const error = "internal: missing last bar after non-empty check";
        this.log({ tsIso: new Date().toISOString(), kind: "ERROR", data: { tickId, message: error } });
        return { ok: false, tickId, error };
      }

      for (const ev of events) {
        this.log({
          tsIso: new Date().toISOString(),
          kind: ev.kind,
          data: { tickId, barIndex: ev.barIndex, reason: ev.reason },
        });
      }

      if (this.emitNoop && events.length === 0) {
        this.log({ tsIso: new Date().toISOString(), kind: "NOOP", data: { tickId } });
      }

      const hooksEvents =
        this.executionHooksScope === "full_window"
          ? events
          : events.filter((e) => e.barIndex === lastIdx && (e.kind === "SIGNAL_ENTRY" || e.kind === "SIGNAL_EXIT"));

      await this.dispatchExecutionHooks(bars, hooksEvents);

      this.log({
        tsIso: new Date().toISOString(),
        kind: "TICK_OK",
        data: { tickId, barCount: bars.length, finalPhase: finalState.phase },
      });

      return {
        ok: true,
        tickId,
        bars,
        indicators,
        strategyEvents: events,
        executionHooksApplied: hooksEvents,
        finalFsmState: finalState,
        lastBarCloseTimeMs: lastBar.timeMs,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log({ tsIso: new Date().toISOString(), kind: "ERROR", data: { tickId, message } });
      return { ok: false, tickId, error: message };
    }
  }

  private async dispatchExecutionHooks(bars: readonly Ohlcv[], hooksEvents: readonly StrategyEvent[]): Promise<void> {
    for (const ev of hooksEvents) {
      if (ev.kind !== "SIGNAL_ENTRY" && ev.kind !== "SIGNAL_EXIT") {
        continue;
      }
      const row = bars[ev.barIndex];
      const timeMs = row?.timeMs ?? -1;
      const payload: ExecutionSignalPayload = { barIndex: ev.barIndex, timeMs, reason: ev.reason };
      if (ev.kind === "SIGNAL_ENTRY") {
        await Promise.resolve(this.execution.onSignalEntry(payload));
      } else {
        await Promise.resolve(this.execution.onSignalExit(payload));
      }
    }
  }
}

export interface PollingHandle {
  stop(): void;
}

/**
 * Fixed-interval polling with overlap protection (Stage 4.2 baseline).
 */
export function startSignalPolling(
  agent: SignalAgent,
  fetchBars: () => Promise<readonly Ohlcv[] | Ohlcv[]>,
  intervalMs: number,
): PollingHandle {
  let stopped = false;
  let busy = false;
  const id = setInterval(() => {
    if (stopped || busy) {
      return;
    }
    busy = true;
    void (async () => {
      try {
        await agent.runTick(fetchBars);
      } finally {
        busy = false;
      }
    })();
  }, intervalMs);
  return {
    stop: () => {
      stopped = true;
      clearInterval(id);
    },
  };
}
