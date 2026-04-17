import { Keypair, SystemProgram, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { createKeypairSigner } from "./keypairSigner.js";

describe("createKeypairSigner", () => {
  it("signs a versioned transaction", async () => {
    const kp = Keypair.generate();
    const msg = new TransactionMessage({
      payerKey: kp.publicKey,
      recentBlockhash: "11111111111111111111111111111111",
      instructions: [SystemProgram.transfer({ fromPubkey: kp.publicKey, toPubkey: kp.publicKey, lamports: 0 })],
    }).compileToV0Message();
    const tx = new VersionedTransaction(msg);
    const sign = createKeypairSigner(kp);
    const out = await sign(tx);
    const sig = out.signatures[0];
    expect(sig?.byteLength).toBe(64);
    // Ed25519 signatures may contain 0x00 bytes; only require "signed" vs default zero buffer.
    expect(sig?.every((b) => b === 0)).toBe(false);
  });
});
