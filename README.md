# sol_bot

Standalone Solana trading POC (VWAP / VWMA 3·9·18, CoinGecko OHLC, Phantom-compatible execution in later stages).

## Requirements

- Node.js 20+

## Setup

```bash
npm install
```

## Commands

```bash
npm test
npm run build
npm run config:print   # Stage 6 — redacted env-derived config (requires devDependency tsx)
npm run signal:jupiter # headless: Gecko OHLCV → signals → Jupiter (see docs/RUNBOOK_SIGNAL_EXEC.md)
```

## 1-minute chart + notifications (no trades)

This starts a local Vite app: 1m candles from **GeckoTerminal**, overlays **VWAP (UTC day)** + **VWMA 3/9/18**, refreshes every **60s**, and fires **browser + on-page notifications** for strategy entry/exit on the **latest closed bar** only (no Phantom / no transactions). **BUY/SELL** rows are stored in **localStorage** and (in dev) appended to **`apps/chart-web/positions.txt`** as JSON Lines; the same page includes a **signal history** table with export to `positions.txt`.

```bash
npm run chart:install
npm run chart:dev
```

Then open the printed URL. A **demo Raydium SOL/USDC pool** loads automatically so the chart is not blank; you can paste any **Solana pool address** (GeckoTerminal OHLCV pool id) and click **Load**. Optional: `http://localhost:5173/?pool=<POOL_ADDRESS>` to skip the demo.

Production build output is written to `apps/chart-web/dist/`:

```bash
npm run chart:install
npm run chart:build
```

## Implemented stages

- **Stage 0** — scope, non-goals, and done criteria: `src/scope/stage0.ts`
- **Stage 1** — formal candle rules, crosses, config pins, FSM: `src/strategy/*`
- **Stage 3** — VWAP (hlc3) + VWMA series: `src/indicators/*`
- **Stage 4** — `SignalAgent` (fetch → indicators → FSM → JSON logs → execution hooks): `src/agent/signalAgent.ts`
- **Stage 5** — Jupiter v6 swap pipeline + safety rails + Model B headless signer; `SIGNING_MODE=phantom_ui` remains for alignment when you integrate Phantom in your own client:
  - Core: `src/execution/*` (`executeJupiterSwap`, `createJupiterSignalExecutionAdapter`, `loadDevKeypairFromEnv`, …)
- **Stage 6** — typed env config (`MODE`, `SIGNING_MODE`, CoinGecko keys, mints, RPC), `SafetyRails` builder, broadcast guard when `MODE≠live`, headless vs Phantom signing alignment: `src/config/botEnv.ts`, `docs/RUNBOOK_STAGE6.md`, `.env.example`.
- **Stage 8** — risk taxonomy, compliance *reminders* (not legal advice), operator checklist, post-POC roadmap: `docs/STAGE8_RISK_AND_COMPLIANCE.md`, encoded one-liners in `src/scope/stage8.ts` (shared educational footer for chart-web).

Full narrative spec: `docs/STANDALONE_TRADING_POC_STAGES.md`.
