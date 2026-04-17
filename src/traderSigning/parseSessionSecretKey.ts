/**
 * Parse a user-pasted Solana secret key for **session-only** automation signing (browser).
 * Accepts base58 (Phantom “export private key”) or JSON byte array `[n,...]` length 64.
 */

import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";

function tryParseJsonByte64(s: string): Uint8Array | null {
  try {
    const v: unknown = JSON.parse(s);
    if (!Array.isArray(v) || v.length !== 64) {
      return null;
    }
    const nums = v as unknown[];
    const out = new Uint8Array(64);
    for (let i = 0; i < 64; i++) {
      const n = nums[i];
      if (typeof n !== "number" || !Number.isInteger(n) || n < 0 || n > 255) {
        return null;
      }
      out[i] = n;
    }
    return out;
  } catch {
    return null;
  }
}

/**
 * @throws Error with a clear message if input cannot be decoded to a 64-byte secret key.
 */
export function parseSessionSecretKey(input: string): Keypair {
  const s = input.trim();
  if (s.length === 0) {
    throw new Error("Secret key input is empty.");
  }

  const jsonBytes = tryParseJsonByte64(s);
  if (jsonBytes !== null) {
    return Keypair.fromSecretKey(jsonBytes);
  }

  try {
    const decoded = bs58.decode(s);
    if (decoded.length !== 64) {
      throw new Error(`Base58 secret decoded to ${decoded.length} bytes (expected 64).`);
    }
    return Keypair.fromSecretKey(Uint8Array.from(decoded));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(
      `Invalid secret key: ${msg}. Use base58 (64-byte secret) or a JSON array of 64 integers 0–255.`,
    );
  }
}
