/**
 * Shared strategy / FSM types (Stages 1+).
 */

export type FsmPhase = "FLAT" | "ARMED" | "LONG";

export type StrategyEventKind =
  | "SIGNAL_ARMED"
  | "SIGNAL_ENTRY"
  | "SIGNAL_EXIT"
  | "INVALIDATED"
  | "NOOP";

export interface StrategyEvent {
  kind: StrategyEventKind;
  /** Index of the bar where the event is recognized (closed bar, no repainting). */
  barIndex: number;
  /** Human-readable reason anchored to the formal spec. */
  reason: string;
}

export type FsmState =
  | { phase: "FLAT" }
  | { phase: "ARMED"; crossIndex: number }
  | { phase: "LONG"; entryIndex: number };
