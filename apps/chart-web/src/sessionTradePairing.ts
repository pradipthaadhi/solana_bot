/**
 * In-memory “one open position per pool” (key = Gecko pool address).
 * - A slot is reserved as soon as we commit to a BUY (before the swap resolves), so duplicate
 *   signals cannot all pass the guard while a swap is in flight.
 * - After a successful SELL, the id is cleared. On failed / skipped BUY, release the slot.
 * - {@link rehydrateOpenPositionFromLog} can restore from persisted rows after reload.
 * Resets on full page reload unless rehydrate runs (same as other desk session state).
 */

import type { PositionSignalRow } from "./positionsLog.js";

const openTradeIdByPool = new Map<string, string>();

/** After clearing persisted positions, drop in-memory open slots (avoids a stuck "already open" guard). */
export function clearInMemoryOpenPositions(): void {
  openTradeIdByPool.clear();
}

export function newTradeId(): string {
  if (globalThis.crypto?.randomUUID) {
    return globalThis.crypto.randomUUID();
  }
  return `tr_${Date.now()}_${Math.random().toString(36).slice(2, 14)}`;
}

/** True if this pool already has an open (or buy-in-flight) position. */
export function hasOpenPositionForPool(poolAddress: string): boolean {
  const k = poolAddress.trim();
  if (k.length === 0) {
    return false;
  }
  const id = openTradeIdByPool.get(k);
  return typeof id === "string" && id.length > 0;
}

/**
 * Reserve the single open slot for this pool before the BUY swap. Returns false if a position
 * is already open (or a prior BUY is still in flight for this pool).
 */
export function tryReserveOpenBuyForPool(poolAddress: string, tradeId: string): boolean {
  const k = poolAddress.trim();
  if (k.length === 0 || tradeId.length === 0) {
    return false;
  }
  if (hasOpenPositionForPool(poolAddress)) {
    return false;
  }
  openTradeIdByPool.set(k, tradeId);
  return true;
}

/**
 * If the in-flight / failed leg used this id, clear it so a new BUY can be attempted
 * (e.g. swap error, mode skip, or kill switch).
 */
export function releaseOpenBuyIfMatches(poolAddress: string, tradeId: string): void {
  const k = poolAddress.trim();
  if (k.length === 0 || tradeId.length === 0) {
    return;
  }
  if (openTradeIdByPool.get(k) === tradeId) {
    openTradeIdByPool.delete(k);
  }
}

/** Idempotent: after a successful on-chain BUY the map already holds this id from {@link tryReserveOpenBuyForPool}. */
export function onBuyFilledPool(poolAddress: string, tradeId: string): void {
  const k = poolAddress.trim();
  if (k.length === 0) {
    return;
  }
  const cur = openTradeIdByPool.get(k);
  if (cur === tradeId) {
    return;
  }
  if (cur !== undefined && cur.length > 0) {
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

/**
 * Restore open-slot state from persisted log (e.g. after reload) so a new BUY is not taken while
 * an on-chain long is still open. Only considers `txStatus === "ok"` rows; chronological `ts` order.
 */
export function rehydrateOpenPositionFromLog(poolAddress: string, rows: readonly PositionSignalRow[]): void {
  const k = poolAddress.trim();
  if (k.length === 0) {
    return;
  }
  if (hasOpenPositionForPool(poolAddress)) {
    return;
  }
  const forPool = rows
    .filter((r) => r.pool.trim() === k)
    .sort((a, b) => a.ts.localeCompare(b.ts));
  let unclosed: string | undefined;
  for (const r of forPool) {
    if (r.txStatus !== "ok" || r.tradeId === undefined || r.tradeId.length === 0) {
      continue;
    }
    if (r.side === "BUY") {
      unclosed = r.tradeId;
    } else if (r.side === "SELL" && r.tradeId === unclosed) {
      unclosed = undefined;
    }
  }
  if (unclosed !== undefined) {
    openTradeIdByPool.set(k, unclosed);
  }
}
