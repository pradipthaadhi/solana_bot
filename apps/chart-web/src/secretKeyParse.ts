import bs58 from "bs58";
import { Keypair } from "@solana/web3.js";

/** Parse Phantom-style secret: base58 (32-byte seed or 64-byte secret key) or JSON byte array. */
export function parseSecretKeyInput(raw: string): { ok: true; keypair: Keypair } | { ok: false; error: string } {
  const t = raw.trim();
  if (t.length === 0) {
    return { ok: false, error: "Secret key is empty." };
  }
  if (t.startsWith("[")) {
    try {
      const arr = JSON.parse(t) as unknown;
      if (!Array.isArray(arr)) {
        return { ok: false, error: "JSON must be an array of byte values (e.g. Phantom key export)." };
      }
      if (arr.some((x) => typeof x !== "number" || !Number.isInteger(x) || x < 0 || x > 255)) {
        return { ok: false, error: "JSON array must contain only integers 0–255." };
      }
      const bytes = Uint8Array.from(arr);
      if (bytes.length !== 64 && bytes.length !== 32) {
        return {
          ok: false,
          error: `JSON array length is ${bytes.length}; expected 32 (seed) or 64 (secret key) bytes.`,
        };
      }
      try {
        const keypair = bytes.length === 64 ? Keypair.fromSecretKey(bytes) : Keypair.fromSeed(bytes);
        return { ok: true, keypair };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : "Invalid key bytes." };
      }
    } catch {
      return { ok: false, error: "Could not parse JSON byte array." };
    }
  }
  try {
    const decoded = bs58.decode(t);
    if (decoded.length === 64) {
      try {
        return { ok: true, keypair: Keypair.fromSecretKey(decoded) };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : "Invalid 64-byte secret key." };
      }
    }
    if (decoded.length === 32) {
      try {
        return { ok: true, keypair: Keypair.fromSeed(decoded) };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : "Invalid 32-byte seed." };
      }
    }
    return { ok: false, error: `Base58 decodes to ${decoded.length} bytes; expected 32 or 64.` };
  } catch {
    return { ok: false, error: "Invalid base58 (check for spaces or typos)." };
  }
}
