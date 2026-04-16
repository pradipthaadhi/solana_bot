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
```

## 1-minute chart + notifications (no trades)

This starts a local Vite app: 1m candles from **GeckoTerminal**, overlays **VWAP (UTC day)** + **VWMA 3/9/18**, refreshes every **60s**, and fires **browser + on-page notifications** for strategy entry/exit on the **latest closed bar** only (no Phantom / no transactions).

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
- **Stage 5** — Jupiter v6 swap pipeline + safety rails + Model B headless signer + Model A Phantom UI:
  - Core: `src/execution/*` (`executeJupiterSwap`, `createJupiterSignalExecutionAdapter`, `loadDevKeypairFromEnv`, …)
  - Phantom dashboard: `apps/trader-web` (install + `npm run trader:dev`)

```bash
npm run trader:install
npm run trader:dev
```

Full narrative spec: `docs/STANDALONE_TRADING_POC_STAGES.md`.
