/**
 * Stage 0 — scope, success criteria, and non-goals (encoded for drift-proof onboarding).
 * @see docs/STANDALONE_TRADING_POC_STAGES.md §0
 */

export const POC_IN_SCOPE = [
  "One configurable Solana SPL token plus one quote asset (SOL/WSOL path).",
  "Signal engine: VWAP, VWMA(3/9/18), entry FSM, exit on bearish VWMA(9)/VWMA(18).",
  "Data ingestion from CoinGecko OHLC with explicit granularity handling.",
  "Execution path compatible with Phantom (human-in-the-loop signing) or an explicit dev signer for tests.",
] as const;

export const POC_OUT_OF_SCOPE = [
  "Multi-pair portfolio, hedging, partial exits, pyramiding, TP/SL ladders.",
  "MEV protection, private RPC, advanced routing (unless added in a later stage).",
  "Profit guarantees or TradingView/PumpSwap 1m parity when data source differs.",
] as const;

export const DONE_CRITERIA = {
  offline_replay:
    "Given a downloaded OHLC series, emit entry/exit timestamps and reasons matching the locked strategy rules.",
  live_paper:
    "Poll data on a timer, emit signals, do not broadcast transactions.",
  live_tiny:
    "On devnet/test or mainnet dust size, successfully sign one buy and one sell via the chosen signing path.",
} as const;

export type DoneCriterionId = keyof typeof DONE_CRITERIA;

export type OperationalMode = "replay" | "paper" | "live";

export const DEFAULT_OPERATIONAL_MODE: OperationalMode = "paper";
