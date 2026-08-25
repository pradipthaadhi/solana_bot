/** Remembers the last pool address that actually loaded OHLCV successfully, across page reloads (this browser only). */
const LS_KEY = "sol_bot_chart_last_pool_v1";

export function loadLastPoolAddress(): string | null {
  try {
    const raw = globalThis.localStorage?.getItem(LS_KEY);
    const trimmed = raw?.trim();
    return trimmed && trimmed.length > 0 ? trimmed : null;
  } catch {
    return null;
  }
}

export function saveLastPoolAddress(address: string): void {
  const trimmed = address.trim();
  if (trimmed.length === 0) {
    return;
  }
  try {
    globalThis.localStorage?.setItem(LS_KEY, trimmed);
  } catch {
    /* private mode / storage unavailable */
  }
}
