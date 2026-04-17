/**
 * Stage 6 — typed configuration from process environment (CoinGecko, mints, RPC, MODE, signing).
 * @see docs/STANDALONE_TRADING_POC_STAGES.md §6
 */

import type { OperationalMode } from "../scope/stage0.js";
import type { SafetyRails } from "../execution/types.js";
import { NATIVE_SOL_MINT } from "../execution/types.js";

/** Model A vs Model B per Stage 5 / Stage 6 table. */
export type SigningMode = "phantom_ui" | "headless_dev";

export interface BotEnv {
  /** CoinGecko `/coins/{id}/ohlc` id (e.g. `solana`). */
  coingeckoCoinId: string | undefined;
  coingeckoVsCurrency: string;
  /** Public CoinGecko auto-granularity: `1` or `2` → ~30m bars. */
  coingeckoOhlcDays: 1 | 2;
  /** SPL mint under test (BUY destination / SELL source). */
  tokenMint: string | undefined;
  /** Quote leg mint (defaults WSOL). */
  quoteMint: string;
  rpcUrl: string;
  /** `replay` = offline CSV/backtest only; `paper` = live data, no on-chain sends; `live` = may broadcast when caller opts in. */
  mode: OperationalMode;
  signingMode: SigningMode;
  solBotHeadlessSigner: boolean;
  solBotKillSwitch: boolean;
  solBotLiveJupiter: boolean;
  /** Optional cap for `SafetyRails.maxInputRaw` (lamports or token raw units). */
  solBotMaxInputRaw: bigint | undefined;
}

const DEFAULT_VS = "usd";
const DEFAULT_RPC = "https://api.mainnet-beta.solana.com";
const DEFAULT_MAX_INPUT_RAW = 50_000n;

function trimUndef(v: string | undefined): string | undefined {
  const t = v?.trim();
  return t && t.length > 0 ? t : undefined;
}

function parseOperationalMode(raw: string | undefined): OperationalMode {
  const s = raw?.trim().toLowerCase();
  if (s === undefined || s.length === 0) {
    return "paper";
  }
  if (s === "replay" || s === "paper" || s === "live") {
    return s;
  }
  throw new Error(`MODE must be replay | paper | live (got ${JSON.stringify(raw)})`);
}

function parseSigningMode(raw: string | undefined): SigningMode {
  const s = raw?.trim().toLowerCase();
  if (s === undefined || s.length === 0) {
    return "phantom_ui";
  }
  if (s === "phantom_ui" || s === "headless_dev") {
    return s;
  }
  throw new Error(`SIGNING_MODE must be phantom_ui | headless_dev (got ${JSON.stringify(raw)})`);
}

function parseOhlcDays(raw: string | undefined): 1 | 2 {
  const s = raw?.trim();
  if (s === undefined || s.length === 0) {
    return 1;
  }
  if (s === "1" || s === "2") {
    return s === "2" ? 2 : 1;
  }
  throw new Error(`COINGECKO_OHLC_DAYS must be 1 or 2 for public ~30m granularity (got ${JSON.stringify(raw)})`);
}

function parseBool01(raw: string | undefined): boolean {
  return raw?.trim() === "1" || raw?.trim().toLowerCase() === "true";
}

function parseBigIntOpt(raw: string | undefined): bigint | undefined {
  const t = raw?.trim();
  if (t === undefined || t.length === 0) {
    return undefined;
  }
  try {
    return BigInt(t);
  } catch {
    throw new Error(`SOL_BOT_MAX_INPUT_RAW must be an integer string (got ${JSON.stringify(raw)})`);
  }
}

/**
 * Load Stage 6 configuration from `process.env` (or tests: pass a plain object).
 */
export function loadBotEnv(env: NodeJS.ProcessEnv = process.env): BotEnv {
  return {
    coingeckoCoinId: trimUndef(env.COINGECKO_COIN_ID),
    coingeckoVsCurrency: trimUndef(env.COINGECKO_VS_CURRENCY) ?? DEFAULT_VS,
    coingeckoOhlcDays: parseOhlcDays(env.COINGECKO_OHLC_DAYS),
    tokenMint: trimUndef(env.TOKEN_MINT),
    quoteMint: trimUndef(env.QUOTE_MINT) ?? NATIVE_SOL_MINT,
    rpcUrl: trimUndef(env.RPC_URL) ?? DEFAULT_RPC,
    mode: parseOperationalMode(env.MODE),
    signingMode: parseSigningMode(env.SIGNING_MODE),
    solBotHeadlessSigner: parseBool01(env.SOL_BOT_HEADLESS_SIGNER),
    solBotKillSwitch: parseBool01(env.SOL_BOT_KILL_SWITCH),
    solBotLiveJupiter: parseBool01(env.SOL_BOT_LIVE_JUPITER),
    solBotMaxInputRaw: parseBigIntOpt(env.SOL_BOT_MAX_INPUT_RAW),
  };
}

/** JSON-safe view for logs / `config:print` (never includes `SOLANA_SECRET_KEY`). */
export function redactBotEnv(e: BotEnv): Record<string, unknown> {
  return {
    coingeckoCoinId: e.coingeckoCoinId ?? null,
    coingeckoVsCurrency: e.coingeckoVsCurrency,
    coingeckoOhlcDays: e.coingeckoOhlcDays,
    tokenMint: e.tokenMint ?? null,
    quoteMint: e.quoteMint,
    rpcUrl: e.rpcUrl,
    mode: e.mode,
    signingMode: e.signingMode,
    solBotHeadlessSigner: e.solBotHeadlessSigner,
    solBotKillSwitch: e.solBotKillSwitch,
    solBotLiveJupiter: e.solBotLiveJupiter,
    solBotMaxInputRaw: e.solBotMaxInputRaw?.toString() ?? null,
  };
}

/**
 * Build {@link SafetyRails} from Stage 6 env + optional overrides.
 * Kill switch follows `SOL_BOT_KILL_SWITCH=1`.
 */
export function buildSafetyRailsFromBotEnv(
  e: BotEnv,
  overrides?: { maxInputRaw?: bigint; killSwitchEngaged?: boolean },
): SafetyRails {
  const maxInputRaw = overrides?.maxInputRaw ?? e.solBotMaxInputRaw ?? DEFAULT_MAX_INPUT_RAW;
  const killSwitchEngaged = overrides?.killSwitchEngaged ?? e.solBotKillSwitch;
  return {
    killSwitchEngaged,
    maxInputRaw,
    operationalMode: e.mode,
  };
}
