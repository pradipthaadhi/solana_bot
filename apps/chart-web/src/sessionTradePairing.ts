/**
 * In-memory FIFO of open BUY trade ids per pool (key = Gecko pool address).
 * SELL rows reuse the id at the head so logs show which SELL pairs with which BUY.
 * Resets on full page reload (same as the rest of the desk session state).
 */

const fifoByPool = new Map<string, string[]>();

export function newTradeId(): string {
  if (globalThis.crypto?.randomUUID) {
    return globalThis.crypto.randomUUID();
  }
  return `tr_${Date.now()}_${Math.random().toString(36).slice(2, 14)}`;
}

/** After a successful on-chain BUY, enqueue this id so the next SELL in this pool can reference it. */
export function onBuyFilledPool(poolAddress: string, tradeId: string): void {
  const k = poolAddress.trim();
  if (k.length === 0) {
    return;
  }
  const q = fifoByPool.get(k) ?? [];
  q.push(tradeId);
  fifoByPool.set(k, q);
}

/** Id the next SELL in this pool should show (oldest unclosed BUY in FIFO), or "" if none. */
export function peekOpenBuyTradeIdForPool(poolAddress: string): string {
  const k = poolAddress.trim();
  const q = fifoByPool.get(k);
  return q && q.length > 0 ? (q[0] ?? "") : "";
}

/** After a successful SELL, consume one queued BUY id. */
export function onSellFilledPool(poolAddress: string): void {
  const k = poolAddress.trim();
  if (k.length === 0) {
    return;
  }
  const q = fifoByPool.get(k);
  if (q && q.length > 0) {
    q.shift();
  }
  if (q && q.length === 0) {
    fifoByPool.delete(k);
  }
}
