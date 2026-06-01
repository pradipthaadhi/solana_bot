/**
 * Mint for the pool's non-SOL leg, derived from GeckoTerminal OHLCV meta when available.
 * Avoids swapping with a stale `VITE_TOKEN_MINT` when the chart pool is x/SOL.
 */
let sessionPoolAltMint: string | null = null;

const POOL_MINT_EVENT = "chart-web:session-pool-swap-mint";

export function setSessionPoolSwapTokenMint(mint: string | null): void {
  sessionPoolAltMint = mint !== null && mint.trim().length > 0 ? mint.trim() : null;
  if (typeof window !== "undefined" && typeof CustomEvent !== "undefined") {
    window.dispatchEvent(new CustomEvent(POOL_MINT_EVENT, { detail: { mint: sessionPoolAltMint } }));
  }
}

/** Prefer GeckoTerminal-resolved mint; else non-empty `VITE_TOKEN_MINT` from env. */
export function getSessionPoolSwapTokenMint(fallbackMint: string): string {
  const fb = fallbackMint.trim();
  return sessionPoolAltMint ?? (fb.length > 0 ? fb : "");
}
