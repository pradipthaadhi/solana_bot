import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import { describe, expect, it } from "vitest";
import { parseSessionSecretKey } from "./parseSessionSecretKey.js";

describe("parseSessionSecretKey", () => {
  it("parses base58-encoded 64-byte secret", () => {
    const kp = Keypair.generate();
    const encoded = bs58.encode(kp.secretKey);
    const parsed = parseSessionSecretKey(encoded);
    expect(parsed.publicKey.toBase58()).toBe(kp.publicKey.toBase58());
  });

  it("parses JSON [64] byte array", () => {
    const kp = Keypair.generate();
    const arr = Array.from(kp.secretKey);
    const parsed = parseSessionSecretKey(JSON.stringify(arr));
    expect(parsed.publicKey.toBase58()).toBe(kp.publicKey.toBase58());
  });

  it("rejects wrong-length base58 payload", () => {
    expect(() => parseSessionSecretKey(bs58.encode(new Uint8Array(32)))).toThrow(/64/i);
  });

  it("rejects empty input", () => {
    expect(() => parseSessionSecretKey("   ")).toThrow(/empty/i);
  });
});
