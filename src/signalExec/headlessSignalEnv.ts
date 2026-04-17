/**
 * Env for headless signal → Jupiter runner (`src/cli/runHeadlessSignalJupiter.ts`).
 * Private keys stay in **Node only** — never in `apps/chart-web`.
 */

/** Default BUY size: 0.001 SOL = 1_000_000 lamports (1 SOL = 1e9 lamports). */
export const DEFAULT_SIGNAL_EXEC_BUY_LAMPORTS = 1_000_000n;

export interface HeadlessSignalExecConfig {
  poolAddress: string;
  geckoApiBaseUrl: string | undefined;
  buySpendLamports: bigint;
  sellTokenRaw: bigint;
  slippageBps: number;
  simulateOnly: boolean;
  pollMs: number;
  /** If true, run a single `runTick` then exit (smoke / CI-friendly when mocked). */
  runOnce: boolean;
}

function trimUndef(v: string | undefined): string | undefined {
  const t = v?.trim();
  return t && t.length > 0 ? t : undefined;
}

function parseBool01(raw: string | undefined): boolean {
  const v = raw?.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

function parsePositiveBigInt(raw: string | undefined, fallback: bigint, label: string): bigint {
  const t = raw?.trim();
  if (t === undefined || t.length === 0) {
    return fallback;
  }
  try {
    const n = BigInt(t);
    if (n <= 0n) {
      throw new Error(`${label} must be > 0`);
    }
    return n;
  } catch (e) {
    throw new Error(`${label} must be a positive integer string (got ${JSON.stringify(raw)}): ${e instanceof Error ? e.message : String(e)}`);
  }
}

function parseSlippageBps(raw: string | undefined): number {
  const t = raw?.trim();
  if (t === undefined || t.length === 0) {
    return 100;
  }
  const n = Number(t);
  if (!Number.isFinite(n) || n < 1 || n > 5000) {
    throw new Error("SIGNAL_EXEC_SLIPPAGE_BPS must be a number in [1, 5000]");
  }
  return Math.floor(n);
}

function parsePollMs(raw: string | undefined): number {
  const t = raw?.trim();
  if (t === undefined || t.length === 0) {
    return 60_000;
  }
  const n = Number(t);
  if (!Number.isFinite(n) || n < 5_000) {
    throw new Error("SIGNAL_EXEC_POLL_MS must be >= 5000");
  }
  return Math.floor(n);
}

/**
 * Parse `SIGNAL_EXEC_*` knobs. Does **not** load keys — use `loadDevKeypairFromEnv` separately.
 */
export function loadHeadlessSignalExecConfig(env: NodeJS.ProcessEnv = process.env): HeadlessSignalExecConfig {
  const poolAddress = trimUndef(env.SIGNAL_EXEC_POOL_ADDRESS);
  if (!poolAddress) {
    throw new Error("SIGNAL_EXEC_POOL_ADDRESS is required (GeckoTerminal Solana pool id, same as chart-web).");
  }

  const geckoApiBaseUrl = trimUndef(env.SIGNAL_EXEC_GECKO_API_BASE);
  const buySpendLamports = parsePositiveBigInt(env.SIGNAL_EXEC_BUY_LAMPORTS, DEFAULT_SIGNAL_EXEC_BUY_LAMPORTS, "SIGNAL_EXEC_BUY_LAMPORTS");
  const sellTokenRaw = parsePositiveBigInt(env.SIGNAL_EXEC_SELL_TOKEN_RAW, 10_000n, "SIGNAL_EXEC_SELL_TOKEN_RAW");
  const slippageBps = parseSlippageBps(env.SIGNAL_EXEC_SLIPPAGE_BPS);

  const simRaw = env.SIGNAL_EXEC_SIMULATE_ONLY?.trim().toLowerCase();
  const simulateOnly = simRaw === undefined || simRaw.length === 0 ? true : !(simRaw === "0" || simRaw === "false" || simRaw === "no");

  const pollMs = parsePollMs(env.SIGNAL_EXEC_POLL_MS);
  const runOnce = parseBool01(env.SIGNAL_EXEC_ONCE);

  return {
    poolAddress,
    geckoApiBaseUrl,
    buySpendLamports,
    sellTokenRaw,
    slippageBps,
    simulateOnly,
    pollMs,
    runOnce,
  };
}
