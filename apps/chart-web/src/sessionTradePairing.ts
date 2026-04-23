/**
 * In-memory “one open position per pool” (key = Gecko pool address).
 * - After a successful BUY we store that row’s trade id until a successful SELL clears it.
 * - A second BUY for the same pool is blocked while an id is present.
 * Resets on full page reload (same as other desk session state).
 */

const openTradeIdByPool = new Map<string, string>();

export function newTradeId(): string {
  if (globalThis.crypto?.randomUUID) {
    return globalThis.crypto.randomUUID();
  }
  return `tr_${Date.now()}_${Math.random().toString(36).slice(2, 14)}`;
}

/** True if this pool already has an open position (successful BUY not yet cleared by successful SELL). */
export function hasOpenPositionForPool(poolAddress: string): boolean {
  const k = poolAddress.trim();
  if (k.length === 0) {
    return false;
  }
  const id = openTradeIdByPool.get(k);
  return typeof id === "string" && id.length > 0;
}

/** After a successful on-chain BUY, record this id until SELL. No-op if a position is already open (defensive). */
export function onBuyFilledPool(poolAddress: string, tradeId: string): void {
  const k = poolAddress.trim();
  if (k.length === 0) {
    return;
  }
  if (hasOpenPositionForPool(poolAddress)) {
    return;
  }
  openTradeIdByPool.set(k, tradeId);
}

/** Id the next SELL in this pool should show, or "" if there is no open position. */
export function peekOpenBuyTradeIdForPool(poolAddress: string): string {
  const k = poolAddress.trim();
  return openTradeIdByPool.get(k) ?? "";
}

/** After a successful SELL, clear the open position for this pool. */
export function onSellFilledPool(poolAddress: string): void {
  const k = poolAddress.trim();
  if (k.length === 0) {
    return;
  }
  openTradeIdByPool.delete(k);
}
