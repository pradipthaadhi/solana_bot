/**
 * Mint for the pool’s non-SOL leg, derived from Gecko OHLCV `meta` when available.
 * Avoids swapping with a stale `VITE_TOKEN_MINT` (e.g. default USDC) when the chart pool is x/SOL.
 */
let sessionPoolAltMint: string | null = null;

export function setSessionPoolSwapTokenMint(mint: string | null): void {
  sessionPoolAltMint = mint !== null && mint.trim().length > 0 ? mint.trim() : null;
}

/** Prefer Gecko-resolved mint; else `VITE_TOKEN_MINT` from env. */
export function getSessionPoolSwapTokenMint(fallbackMint: string): string {
  return sessionPoolAltMint ?? fallbackMint;
}
