/**
 * Stage 8 — risks, compliance posture, and post-POC roadmap (encoded anchors; not legal advice).
 * @see docs/STAGE8_RISK_AND_COMPLIANCE.md
 * @see docs/STANDALONE_TRADING_POC_STAGES.md §8
 */

/** Short copy for chart-web footers (plain text; keep in sync with user-visible disclaimers). */
export const STAGE8_EDUCATIONAL_FOOTER = ''
/**
 * Market and model risk themes (§8.1). Each item is an operator-facing reminder, not a forecast.
 */
export const MARKET_AND_MODEL_RISK_THEMES = [
  "Pump-phase and trend regimes are non-stationary; a rule that fits one window often degrades out-of-sample.",
  "Backtests and chart replays omit liquidity impact, queue position, and adverse selection at the moment of click.",
  "Latency between signal bar close, UI refresh, wallet signing, and chain inclusion can change fills vs the modeled bar.",
  "Partial fills, route changes, and failed simulations are normal operational outcomes, not edge cases.",
  "OHLCV from aggregators (e.g. GeckoTerminal) may disagree with exchange tape or TradingView on session, volume, or time alignment.",
] as const;

/**
 * Legal / policy reminders (§8.2). This is **not** legal advice; operators must retain qualified counsel where needed.
 */
export const LEGAL_AND_POLICY_REMINDERS = [
  "Determine whether your jurisdiction treats automated or discretionary crypto activity as regulated (e.g. licensing, reporting).",
  "Read and comply with terms of service for each venue you touch: RPC providers, Jupiter, DEXs, data APIs, and wallet software.",
  "Maintain records suitable for tax and audit: timestamps, mints, amounts, fees, signatures, and counterparty identifiers.",
  "Sanctions, export controls, and platform geoblocks may prohibit certain flows even when technically possible.",
] as const;

/**
 * Suggested engineering iterations after the POC (§8.3).
 */
export const SUGGESTED_POST_POC_ITERATIONS = [
  "Higher-fidelity candles (e.g. DEX or CEX websocket streams) if 1m parity with a reference venue is required.",
  "Explicit fee, priority-fee, and slippage models in replay/backtest to avoid optimistic PnL.",
  "Multi-venue routing, inventory, and hedging when size or holding period grows.",
  "Monitoring, alerting, runbooks for RPC degradation, Jupiter errors, and signer failures.",
  "Key rotation, hardware signing, or custody separation before scaling beyond dust sizes.",
] as const;
