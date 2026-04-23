import { readDeskEnv } from "./chartWebEnv.js";

const EL_ID = "signal-auto-sol-amount";

/**
 * Convert user string (e.g. "0.1", "0.001") to lamports. Max 1000 SOL for a sanity cap.
 */
export function parseSolStringToLamports(raw: string): { ok: true; lamports: bigint } | { ok: false; error: string } {
  let t = raw.trim().replace(",", ".");
  if (t.length === 0) {
    return { ok: false, error: "Empty amount." };
  }
  if (t.startsWith(".")) {
    t = `0${t}`;
  }
  if (!/^\d+(\.\d+)?$/.test(t)) {
    return { ok: false, error: "Use a decimal number (e.g. 0.1 or 0.001)." };
  }
  const n = Number(t);
  if (!Number.isFinite(n) || n <= 0) {
    return { ok: false, error: "Amount must be a positive number." };
  }
  if (n > 1000) {
    return { ok: false, error: "Amount exceeds 1000 SOL cap." };
  }
  const lam = BigInt(Math.round(n * 1e9));
  if (lam < 1n) {
    return { ok: false, error: "Amount rounds to 0 lamports (try a larger value)." };
  }
  return { ok: true, lamports: lam };
}

/**
 * BUY (ExactIn) and SELL (ExactOut) use the same SOL notional from the desk input.
 * If the field is empty or missing, use `.env` buy/sell lamport defaults.
 */
export function getSignalAutoTradeLamports():
  | { ok: true; buy: bigint; sell: bigint }
  | { ok: false; error: string } {
  const el = document.getElementById(EL_ID);
  if (el !== null && el instanceof HTMLInputElement) {
    const t = el.value.trim();
    if (t.length > 0) {
      const p = parseSolStringToLamports(t);
      if (!p.ok) {
        return { ok: false, error: p.error };
      }
      return { ok: true, buy: p.lamports, sell: p.lamports };
    }
  }
  const env = readDeskEnv();
  return { ok: true, buy: env.signalBuyLamports, sell: env.signalSellOutLamports };
}

export function setSignalAutoSolInputToEnvDefaults(): void {
  const el = document.getElementById(EL_ID);
  if (el === null || !(el instanceof HTMLInputElement)) {
    return;
  }
  const { signalBuyLamports: buy } = readDeskEnv();
  el.value = String(Number(buy) / 1e9);
}
