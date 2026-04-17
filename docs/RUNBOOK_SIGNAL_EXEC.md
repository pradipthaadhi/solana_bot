# Headless signal → Jupiter execution (0.001 SOL default BUY)

This path runs **`SignalAgent`** on **GeckoTerminal 1m OHLCV** (same pool id as chart-web) and, on tail **`SIGNAL_ENTRY` / `SIGNAL_EXIT`**, calls **`executeJupiterSwap`** via **`createJupiterSignalExecutionAdapter`**.

- **Private keys run in Node only** (`SOLANA_SECRET_KEY` + `SOL_BOT_HEADLESS_SIGNER=1`). Do **not** put secrets in `apps/chart-web` or `apps/trader-web`.
- **Deduping** (`createDedupingExecutionAdapter`) prevents the same signal from firing a swap every poll while it stays inside the tail window.
- **Chart-web stays notify-only**; use this runner for automated legs.

## 1. Prerequisites

- Node 20+, repo `npm install`
- A **GeckoTerminal Solana pool address** (same string you paste in chart-web)
- `TOKEN_MINT` = the **output mint on BUY** / **input mint on SELL** (must match the pair you trade; often the pool’s non-SOL leg)
- `SOL_BOT_MAX_INPUT_RAW` ≥ `SIGNAL_EXEC_BUY_LAMPORTS` **and** ≥ `SIGNAL_EXEC_SELL_TOKEN_RAW` (the executor caps **each leg’s** quoted input against this field)
- Headless signer: `SOL_BOT_HEADLESS_SIGNER=1`, `SIGNING_MODE=headless_dev`, `SOLANA_SECRET_KEY` (base58 or JSON byte array)

## 2. Environment (minimal)

```bash
export SIGNAL_EXEC_ENABLED=1
export SIGNAL_EXEC_POOL_ADDRESS="<GeckoTerminal pool id>"
export TOKEN_MINT="<SPL mint for Jupiter legs>"
export RPC_URL="<your paid mainnet RPC recommended>"
export MODE=paper                    # safe default
export SIGNAL_EXEC_SIMULATE_ONLY=1 # default if unset — Jupiter quote + simulate only
export SOL_BOT_MAX_INPUT_RAW=5000000
export SOL_BOT_KILL_SWITCH=0
export SOL_BOT_HEADLESS_SIGNER=1
export SIGNING_MODE=headless_dev
export SOLANA_SECRET_KEY="<never commit>"
```

### Size knobs

| Variable | Default | Meaning |
|----------|---------|---------|
| `SIGNAL_EXEC_BUY_LAMPORTS` | `1000000` | **0.001 SOL** (lamports) ExactIn on `SIGNAL_ENTRY` |
| `SIGNAL_EXEC_SELL_TOKEN_RAW` | `10000` | ExactIn token raw on `SIGNAL_EXIT` — **set for your mint decimals** |
| `SIGNAL_EXEC_SLIPPAGE_BPS` | `100` | Slippage tolerance |
| `SIGNAL_EXEC_POLL_MS` | `60000` | Poll interval |
| `SIGNAL_EXEC_ONCE` | `0` | Set `1` for a single tick then exit (smoke) |
| `SIGNAL_EXEC_GECKO_API_BASE` | unset | Optional Gecko API base override |

## 3. Real on-chain sends (review twice)

1. `MODE=live`
2. `SIGNAL_EXEC_SIMULATE_ONLY=0`
3. Tiny `SIGNAL_EXEC_BUY_LAMPORTS` / `SIGNAL_EXEC_SELL_TOKEN_RAW` you can afford to lose
4. `docs/RUNBOOK_STAGE6.md` + `docs/STAGE8_RISK_AND_COMPLIANCE.md` checklist

## 4. Run

```bash
npm run signal:jupiter
```

One-shot smoke (still hits network for Gecko + Jupiter unless you mock in tests):

```bash
export SIGNAL_EXEC_ONCE=1
npm run signal:jupiter
```

## 5. Safety rails

- `SOL_BOT_KILL_SWITCH=1` → runner refuses to start.
- `MODE≠live` and `SIGNAL_EXEC_SIMULATE_ONLY=0` → refused (on-chain send policy).
- `createDedupingExecutionAdapter` avoids duplicate swaps for the same `(kind, barIndex, timeMs)`.
