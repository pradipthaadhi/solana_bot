import type { Keypair } from "@solana/web3.js";
import { parseSecretKeyInput } from "./secretKeyParse.js";

let sessionKeypair: Keypair | null = null;

function emitDeskWalletChanged(): void {
  if (typeof window === "undefined" || typeof CustomEvent === "undefined") {
    return;
  }
  const addr = sessionKeypair?.publicKey.toBase58() ?? "";
  window.dispatchEvent(new CustomEvent("chart-web:desk-wallet-changed", { detail: { address: addr } }));
}

/** Loads `VITE_DESK_PRIVATE_KEY` from the Vite build (set in `apps/chart-web/.env`). */
export function initDeskTradingKeyFromEnv(): { ok: true } | { ok: false; error: string } {
  const raw = import.meta.env.VITE_DESK_PRIVATE_KEY;
  if (raw === undefined || String(raw).trim().length === 0) {
    sessionKeypair = null;
    emitDeskWalletChanged();
    return { ok: false, error: "VITE_DESK_PRIVATE_KEY is missing or empty." };
  }
  const parsed = parseSecretKeyInput(String(raw));
  if (!parsed.ok) {
    sessionKeypair = null;
    emitDeskWalletChanged();
    return { ok: false, error: parsed.error };
  }
  sessionKeypair = parsed.keypair;
  emitDeskWalletChanged();
  return { ok: true };
}

export function setSessionTradingKeypair(kp: Keypair): void {
  sessionKeypair = kp;
  emitDeskWalletChanged();
}

export function getSessionTradingKeypair(): Keypair | null {
  return sessionKeypair;
}

export function clearSessionTradingKeypair(): void {
  sessionKeypair = null;
  emitDeskWalletChanged();
}
