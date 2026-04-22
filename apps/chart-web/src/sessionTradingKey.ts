import type { Keypair } from "@solana/web3.js";
import { parseSecretKeyInput } from "./secretKeyParse.js";

let sessionKeypair: Keypair | null = null;

/** Loads `VITE_DESK_PRIVATE_KEY` from the Vite build (set in `apps/chart-web/.env`). */
export function initDeskTradingKeyFromEnv(): { ok: true } | { ok: false; error: string } {
  const raw = import.meta.env.VITE_DESK_PRIVATE_KEY;
  if (raw === undefined || String(raw).trim().length === 0) {
    return { ok: false, error: "VITE_DESK_PRIVATE_KEY is missing or empty." };
  }
  const parsed = parseSecretKeyInput(String(raw));
  if (!parsed.ok) {
    return { ok: false, error: parsed.error };
  }
  sessionKeypair = parsed.keypair;
  return { ok: true };
}

export function setSessionTradingKeypair(kp: Keypair): void {
  sessionKeypair = kp;
}

export function getSessionTradingKeypair(): Keypair | null {
  return sessionKeypair;
}

export function clearSessionTradingKeypair(): void {
  sessionKeypair = null;
}
