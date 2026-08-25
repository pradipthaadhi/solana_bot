/**
 * In-memory “one open position per pool” (key = Gecko pool address).
 * - A slot is reserved as soon as we commit to a BUY (before the swap resolves), so duplicate
 *   signals cannot all pass the guard while a swap is in flight.
 * - After a successful SELL, the id is cleared. On failed / skipped BUY, release the slot.
 * - {@link rehydrateOpenPositionFromLog} can restore from persisted rows after reload.
 * Resets on full page reload unless rehydrate runs (same as other desk session state).
 */

import type { PositionSignalRow } from "./positionsLog.js";

/**
 * Exact text `signalAutoExecution.ts` uses when a SELL is skipped because the wallet's real
 * on-chain balance for the tracked mint is confirmed zero. Lives here (not in
 * signalAutoExecution.ts, which imports this module) so {@link rehydrateOpenPositionFromLog} can
 * recognize it too without a circular import. A confirmed-zero balance is ground truth that a
 * tracked position already closed by some means auto-trading never saw (manual sell, cross-instance
 * desync, ...) — both the live path (onSignalExit) and log replay (rehydrate) treat it as a close.
 */
export const ZERO_BALANCE_SELL_SKIP_DETAIL = "No token balance to sell (desk wallet holds 0 of this mint).";

const openTradeIdByPool = new Map<string, string>();

const RESET_WATERMARK_LS_KEY = "sol_bot_trade_pairing_reset_at_v1";

function loadResetWatermark(): string | null {
  try {
    const raw = globalThis.localStorage?.getItem(RESET_WATERMARK_LS_KEY);
    return raw && raw.trim().length > 0 ? raw : null;
  } catch {
    return null;
  }
}

function saveResetWatermark(iso: string): void {
  try {
    globalThis.localStorage?.setItem(RESET_WATERMARK_LS_KEY, iso);
  } catch {
    /* private mode */
  }
}

/** After clearing persisted positions, drop in-memory open slots (avoids a stuck "already open" guard). */
export function clearInMemoryOpenPositions(): void {
  openTradeIdByPool.clear();
}

/**
 * Manually reset open-position tracking for every pool, "as of now" — the "Start New" button in
 * the signal-history UI. Unlike {@link clearInMemoryOpenPositions} (paired with deleting the log
 * in "Clear all"), this deliberately does NOT touch any persisted row — every previous BUY/SELL
 * stays in the history for the record. What it also does, which a bare Map.clear() would not:
 * records a watermark so a subsequent {@link rehydrateOpenPositionFromLog} (every tick/reload)
 * can't just reconstruct the exact same "open" state from that preserved pre-reset history and
 * silently undo the reset — rows at or before this instant are excluded from that replay from now
 * on. Trading state starts flat; the audit trail does not.
 */
export function resetTradePairingTracking(): void {
  openTradeIdByPool.clear();
  saveResetWatermark(new Date().toISOString());
}

/**
 * Number of pools currently tracked as having an open (auto-bought, not yet auto-sold) position.
 * Since {@link clearInMemoryOpenPositions} drops this tracking, and `onSignalExit` now refuses to
 * sell an untracked pool (see signalAutoExecution.ts), callers should warn before clearing when
 * this is non-zero — otherwise a real open position quietly stops being auto-sellable.
 */
export function openPositionPoolCount(): number {
  return openTradeIdByPool.size;
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
  const watermark = loadResetWatermark();
  const forPool = rows
    .filter((r) => r.pool.trim() === k)
    // A "Start New" reset means "ignore everything up to and including this instant" — rows at or
    // before the watermark must not resurrect pre-reset tracking state.
    .filter((r) => watermark === null || r.ts > watermark)
    .sort((a, b) => a.ts.localeCompare(b.ts));
  let unclosed: string | undefined;
  for (const r of forPool) {
    // A confirmed-zero-balance SELL skip for the currently-tracked buy closes it exactly like a
    // successful SELL would — see ZERO_BALANCE_SELL_SKIP_DETAIL. Checked before the `txStatus
    // !== "ok"` filter below, since this row's status is "skipped", not "ok".
    if (r.side === "SELL" && r.txDetail === ZERO_BALANCE_SELL_SKIP_DETAIL && r.tradeId === unclosed) {
      unclosed = undefined;
      continue;
    }
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
