import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import { describe, expect, it } from "vitest";
import { loadDevKeypairFromEnv } from "./devKeypair.js";

describe("loadDevKeypairFromEnv (Stage 5.2)", () => {
  it("requires SOL_BOT_HEADLESS_SIGNER=1", () => {
    const kp = Keypair.generate();
    expect(() =>
      loadDevKeypairFromEnv({
        SOLANA_SECRET_KEY: bs58.encode(kp.secretKey),
      }),
    ).toThrow(/Headless signer disabled/);
  });

  it("loads base58 secret when flag set", () => {
    const kp = Keypair.generate();
    const out = loadDevKeypairFromEnv({
      SOL_BOT_HEADLESS_SIGNER: "1",
      SOLANA_SECRET_KEY: bs58.encode(kp.secretKey),
    });
    expect(out.publicKey.toBase58()).toBe(kp.publicKey.toBase58());
  });

  it("loads JSON array secret when flag set", () => {
    const kp = Keypair.generate();
    const out = loadDevKeypairFromEnv({
      SOL_BOT_HEADLESS_SIGNER: "1",
      SOLANA_SECRET_KEY: JSON.stringify([...kp.secretKey]),
    });
    expect(out.publicKey.toBase58()).toBe(kp.publicKey.toBase58());
  });
});
