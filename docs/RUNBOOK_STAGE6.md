# Stage 6 — Configuration, secrets, and operations

## 1. Environment layout

| Variable | Role |
|----------|------|
| `COINGECKO_COIN_ID` | CoinGecko `/coins/{id}/ohlc` id when you wire Stage 2 CoinGecko fetch |
| `COINGECKO_VS_CURRENCY` | `usd` or `sol` |
| `COINGECKO_OHLC_DAYS` | `1` or `2` (public API → ~30m bars) |
| `TOKEN_MINT` | SPL mint under test |
| `QUOTE_MINT` | Usually wrapped SOL (`So1111…`) |
| `RPC_URL` | HTTP(S) Solana RPC |
| `MODE` | `replay` \| `paper` \| `live` — controls **on-chain broadcast guard** in `executeJupiterSwap` |
| `SIGNING_MODE` | `phantom_ui` \| `headless_dev` — must align with how you sign |
| `SOL_BOT_MAX_INPUT_RAW` | Optional per-leg cap (bigint string) for `SafetyRails.maxInputRaw` |
| `SOL_BOT_KILL_SWITCH` | `1` = halt swaps at safety layer |
| `SOL_BOT_HEADLESS_SIGNER` | `1` + `SOLANA_SECRET_KEY` for Model B |
| `SOL_BOT_LIVE_JUPITER` | `1` = run optional live Jupiter Vitest |

## 2. Secrets (non-negotiable)

- Keep **`.env` gitignored**; rotate any key that was committed or pasted into logs.
- **Never** set `SIGNING_MODE=phantom_ui` while loading a headless keypair — `loadDevKeypairFromEnv` rejects that mismatch.
- Production: use a secret manager; `.env` is for local POC only.

## 3. Operational modes

- **`MODE=paper` (default):** fetch, simulate, sign in UI — but **`executeJupiterSwap` throws `MODE_PAPER`** if `broadcast: true`. Use simulate-only paths or unset `operationalMode` on rails for legacy tests.
- **`MODE=live`:** on-chain broadcast allowed when the caller passes `broadcast: true`. Still subject to kill switch and max input.
- **`MODE=replay`:** same broadcast guard as paper; for offline CSV / backtests.

## 4. Inspect resolved config

From repo root (loads `process.env`):

```bash
npm install
npm run config:print
```

Output is **redacted** (no `SOLANA_SECRET_KEY`).

## 5. Programmatic access

```typescript
import { loadBotEnv, buildSafetyRailsFromBotEnv } from "sol_bot/config/botEnv.js";

const env = loadBotEnv();
const rails = buildSafetyRailsFromBotEnv(env);
```

Pass `rails` into `executeJupiterSwap` / `createJupiterSignalExecutionAdapter` so `MODE` is enforced on broadcast.

## 6. Checklist before mainnet dust

- [ ] `MODE=live` only after explicit review.
- [ ] `SOL_BOT_MAX_INPUT_RAW` set to a **tiny** cap.
- [ ] `SOL_BOT_KILL_SWITCH=0` or unset; verify UI / runner maps kill switch correctly.
- [ ] RPC healthy (`assertRpcHealthy` in executor path).
- [ ] Jupiter simulation clean before first send.

## 7. Trader web (`apps/trader-web`)

Browser builds cannot read `process.env` the same way as Node. This app uses **`import.meta.env`** with a `VITE_` prefix (see `apps/trader-web/.env.example` and `apps/trader-web/src/traderEnv.ts`):

| Variable | Role |
|----------|------|
| `VITE_MODE` | Same as `MODE` — default **paper** when unset |
| `VITE_RPC_URL` | Initial RPC field |
| `VITE_TOKEN_MINT` | Initial output mint |
| `VITE_SOL_BOT_MAX_INPUT_RAW` | Optional default for the safety cap field |
| `VITE_SOL_BOT_KILL_SWITCH` | Same as `SOL_BOT_KILL_SWITCH` — `1` locks kill switch on |

With `VITE_MODE=paper` or `replay`, the UI still requests quotes and simulation; if **Simulate only** is off, Phantom may sign but **`broadcast` stays false** so nothing is sent on-chain. Set `VITE_MODE=live` only for intentional mainnet sends.

## 8. Related — Stage 8 risk and compliance

Before scaling size or responsibility, read **`docs/STAGE8_RISK_AND_COMPLIANCE.md`** (operator checklist §7, incident response §8).
