# Stage 6 — Configuration, secrets, and operations

## 1. Environment layout

| Variable | Role |
|----------|------|
| `COINGECKO_COIN_ID` | CoinGecko `/coins/{id}/ohlc` id when you wire Stage 2 CoinGecko fetch |
| `COINGECKO_VS_CURRENCY` | `usd` or `sol` |
| `COINGECKO_OHLC_DAYS` | `1` or `2` (public API → ~30m bars) |
| `TOKEN_MINT` | SPL mint under test |
| `QUOTE_MINT` | Usually wrapped SOL (`So1111…`) |
| `RPC_URL` | Private mainnet HTTPS Solana RPC (e.g. Alchemy); public `api.mainnet-beta` rate-limits / 403s |
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
- [ ] `SOL_BOT_KILL_SWITCH=0` or unset; verify chart / runner maps kill switch correctly.
- [ ] RPC healthy (`assertRpcHealthy` in executor path).
- [ ] Jupiter simulation clean before first send.

## 7. Related — Stage 8 risk and compliance

Before scaling size or responsibility, read **`docs/STAGE8_RISK_AND_COMPLIANCE.md`** (operator checklist §7, incident response §8).
