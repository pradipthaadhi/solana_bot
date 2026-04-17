/**
 * Stage 5.2 — headless signer material (Model B). Never commit secrets.
 */

import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";

function parseSecretKey(raw: string): Uint8Array {
  const t = raw.trim();
  if (t.startsWith("[")) {
    const arr = JSON.parse(t) as unknown;
    if (!Array.isArray(arr) || !arr.every((x) => typeof x === "number")) {
      throw new Error("SOLANA_SECRET_KEY JSON must be a number array.");
    }
    return Uint8Array.from(arr);
  }
  return bs58.decode(t);
}

/**
 * Load a `Keypair` from `SOLANA_SECRET_KEY` (base58 or JSON byte array), gated by `SOL_BOT_HEADLESS_SIGNER=1`.
 */
export function loadDevKeypairFromEnv(env: NodeJS.ProcessEnv = process.env): Keypair {
  if (env.SOL_BOT_HEADLESS_SIGNER !== "1") {
    throw new Error("Headless signer disabled: set SOL_BOT_HEADLESS_SIGNER=1 explicitly for Model B.");
  }
  const signing = env.SIGNING_MODE?.trim().toLowerCase();
  if (signing === "phantom_ui") {
    throw new Error(
      "SIGNING_MODE=phantom_ui conflicts with headless keypair loading. Use Model A (Phantom UI) or set SIGNING_MODE=headless_dev.",
    );
  }
  const raw = env.SOLANA_SECRET_KEY;
  if (!raw || raw.trim().length === 0) {
    throw new Error("Missing SOLANA_SECRET_KEY for headless signer.");
  }
  return Keypair.fromSecretKey(parseSecretKey(raw));
}
