# Stage 7 — Verification (implemented checks + manual matrix)

This document operationalizes `docs/STANDALONE_TRADING_POC_STAGES.md` §7. For risk, compliance reminders, and operator acceptance before scaling capital, see **`docs/STAGE8_RISK_AND_COMPLIANCE.md`**.

## 7.1 Indicator parity (TradingView / external reference)

**Automated (analytical):** `src/verification/stage7Parity.test.ts` proves:

- UTC-day VWAP matches cumulative \(\sum (hlc3 \cdot vol) / \sum vol\) within one UTC calendar day.
- VWMA rolling windows match a hand-computed window and match the standalone `computeVwmaSeries` output against `computeBarIndicators`.

**Manual (TV bar-by-bar):** Export the same OHLCV window you feed the repo (same `timeMs` as bar close, same volume column). In TradingView:

- Use the **same timeframe** (e.g. 1m).
- Match **VWAP anchor** to code: `DEFAULT_STRATEGY_CONFIG` uses **`UTC_DAY`** (reset at 00:00 UTC), not exchange session VWAP.
- Match **volume** source; GeckoTerminal / API volume may differ from exchange feed → expect drift.

If analytical tests pass but TV differs, almost always the anchor or volume path differs—not necessarily a code bug.

## 7.2 Signal replay (frozen golden)

**Artifacts:** `fixtures/stage7/`

- `replay_bars.json` — frozen bars (JSON equivalent of CSV).
- `indicators.golden.json` / `fsm_events.golden.json` — committed goldens.
- `manifest.json` — metadata (`barCount`, `finalPhase`, …).

**Automated:** `src/verification/stage7Replay.test.ts` recomputes indicators + FSM and asserts equality with goldens.

**Regenerate goldens** after you intentionally change VWAP/VWMA/FSM semantics:

```bash
npm run stage7:gen-golden
npm test
```

## 7.3 Chain test (RPC liveness, opt-in)

**Automated (no swaps, no private keys):** `src/verification/stage7Chain.test.ts` runs only when:

```bash
export SOL_BOT_STAGE7_CHAIN_TEST=1
# optional overrides:
# export STAGE7_DEVNET_RPC_URL=https://api.devnet.solana.com
# export STAGE7_MAINNET_RPC_URL=https://solana-mainnet.g.alchemy.com/v2/<KEY>   # or any private mainnet HTTPS RPC
npm test
```

- Always runs a **devnet** `getLatestBlockhash` health check when enabled.
- Runs an optional **mainnet read-only** check only if `STAGE7_MAINNET_RPC_URL` is set (avoids hammering the public mainnet endpoint in CI).

**Manual (swaps):** Follow `docs/RUNBOOK_STAGE6.md` — devnet rehearsal first, then **mainnet micro** only after Jupiter simulation is clean, balances verified, caps and `MODE` reviewed. The repo does not auto-send mainnet txs in tests by design.
