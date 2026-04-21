# Stage 8 — Risk, compliance, and responsible operations

This document **implements** `docs/STANDALONE_TRADING_POC_STAGES.md` §8 in a form suitable for engineers, researchers, and operators. It is **educational** and **not legal, tax, or investment advice**. When in doubt, retain qualified professionals in your jurisdiction.

---

## 1. Purpose and scope

**Purpose.** Make implicit dangers explicit: where the POC can mislead you, where law and contracts may constrain you, and what to build next if you graduate beyond a toy system.

**Scope.** Covers (a) market and model risk, (b) legal and policy *reminders* (not advice), (c) a structured post-POC roadmap. It does **not** certify compliance with any statute or venue rule.

**Related documents.**

| Topic | Document |
|--------|-----------|
| Env, `MODE`, kill switch, mainnet checklist | `docs/RUNBOOK_STAGE6.md` |
| Verification matrix (indicators, replay, RPC) | `docs/STAGE7_VERIFICATION.md` |
| Full staged narrative | `docs/STANDALONE_TRADING_POC_STAGES.md` |
| Drift-proof one-liners in code | `src/scope/stage8.ts` |

---

## 2. Definitions (use consistently)

- **Signal** — A strategy event (e.g. `SIGNAL_ENTRY`) derived from **closed** OHLCV bars and pinned indicator rules.
- **Quote / simulation** — Jupiter + RPC may return a route or a simulated execution that **still fails** at send time (congestion, account state, priority fees).
- **Broadcast** — Submitting a signed transaction to the network. Controlled in this repo by `SafetyRails.operationalMode`, UI flags, and `executeJupiterSwap` guards.
- **Aggregator OHLCV** — Third-party candles (e.g. GeckoTerminal) that may **not** match exchange matching engines or your broker’s tape.

---

## 3. Market and model risk (§8.1)

### 3.1 Non-stationarity and overfitting

Financial time series during speculative phases are **non-stationary**: volatility, drift, and microstructure change. A rule that looks excellent on one screenshot or one CSV window often **fails** on adjacent windows. Treat every good backtest as **hypothesis**, not proof.

**Mitigations.** Hold out data, walk-forward evaluation, stress scenarios (fee spikes, gaps), and explicit “no trade” regimes. Prefer small capital until behavior is stable across regimes.

### 3.2 Latency and signal–execution gap

Your signal is computed on a **closed** bar at time \(T\). By the time a human confirms in a wallet, the book may have moved. **Partial fills**, **route changes**, and **failed simulations** are normal.

**Mitigations.** Re-quote immediately before sign; cap size; use `simulateTransaction` (already in `executeJupiterSwap`); monitor slippage vs `slippageBps`.

### 3.3 Data and indicator divergence

If TradingView, an exchange, and GeckoTerminal disagree, **all three can be internally consistent** with their own session, volume, and candle-close rules. VWAP in this repo defaults to **UTC calendar day** reset (`DEFAULT_STRATEGY_CONFIG`); many charting products default to **session** VWAP.

**Mitigations.** Document the exact bar source and VWAP mode before claiming “parity.” See Stage 7.1 in `docs/STAGE7_VERIFICATION.md`.

---

## 4. Execution and operational risk

| Risk | Notes | Repo touchpoints |
|------|--------|------------------|
| Hot wallet / key exposure | Headless signing is dangerous at scale. | `src/execution/devKeypair.ts`, `SIGNING_MODE` |
| Wrong network or mint | User error → lost funds or stuck tokens. | `botEnv`, mint fields |
| RPC abuse or failure | Public mainnet RPCs rate-limit and often return **403** to browsers; use a private HTTPS provider (e.g. Alchemy CU-based free tier, ~25 RPS class plans — see https://www.alchemy.com/pricing ). | `assertRpcHealthy`, `VITE_RPC_URL` / `RPC_URL`, paid RPC in prod |
| Kill switch forgotten | Trades continue when they should not. | `SOL_BOT_KILL_SWITCH`, UI checkbox |
| `MODE` mismatch | Accidental “live” broadcast. | `MODE`, runbook |

---

## 5. Legal, regulatory, and policy (§8.2)

**Not legal advice.** Laws differ by country and region. Activities that look like “personal experimentation” can still trigger **tax reporting**, **licensing**, **consumer protection**, or **AML/KYC** obligations depending on facts and scale.

**Practical recordkeeping (non-exhaustive).** For each on-chain leg, retain: UTC timestamp, cluster, signature, mints, amounts in raw units and human decimals, fees, counterparty programs, and the quote JSON or a hash of it. Store logs outside the hot wallet machine when possible.

**Venue and API terms.** Jupiter, DEXs, RPC providers, and data APIs impose **terms of use** and sometimes **prohibited jurisdictions**. You—not this repository—are responsible for reading and honoring them.

---

## 6. Post-POC engineering roadmap (§8.3)

High-value extensions (prioritize based on your actual failure modes):

1. **Better candles** — Websocket or exchange-native 1m streams if you require tape-aligned signals.
2. **Realistic PnL model** — Fees, priority fees, partial fills, and borrow if applicable.
3. **Inventory and risk** — Position limits, max drawdown halts, multi-asset exposure.
4. **Operations** — Dashboards for RPC health, fill quality, and alert routing (PagerDuty, Slack, etc.).
5. **Signing architecture** — Hardware wallets, multisig, or offline approval for non-trivial notional.

Encoded short list: `SUGGESTED_POST_POC_ITERATIONS` in `src/scope/stage8.ts`.

---

## 7. Operator acceptance checklist (pre–non-trivial capital)

Copy into your own tracker and sign off with names/dates.

- [ ] Read `docs/RUNBOOK_STAGE6.md` and run `npm run config:print` with the **intended** `.env`.
- [ ] Confirm `MODE` / `VITE_MODE` matches the intended broadcast policy (`paper` vs `live`).
- [ ] Confirm max input caps and kill switch behavior on a **dry** run.
- [ ] Complete Stage 7 replay tests (`npm test`) after any strategy or indicator change.
- [ ] Optional: Stage 7 chain RPC check with `SOL_BOT_STAGE7_CHAIN_TEST=1`.
- [ ] Legal / tax: internal note on who owns responsibility and which records you will retain.
- [ ] Venue ToS: Jupiter + RPC + data provider reviewed for your use case.

---

## 8. Incident response (lightweight)

If something goes wrong in production-like use:

1. **Stop trading** — Enable kill switch; set `MODE=paper` or stop the process.
2. **Preserve evidence** — Logs, env snapshot (redacted), last good signature, RPC endpoint id.
3. **Assess blast radius** — Wallets, mints, open positions, stuck accounts.
4. **Post-mortem** — One page: timeline, root cause class (data / code / ops / external), corrective actions.

---

## 9. Versioning

Update `src/scope/stage8.ts` when you add **new** canonical risk themes so tests and UIs stay aligned. Update this document when operational policy changes materially.
