import { Keypair, SystemProgram, TransactionMessage, VersionedTransaction, type Connection } from "@solana/web3.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as jupiter from "./jupiterClient.js";
import { executeJupiterSwap } from "./swapExecutor.js";

function sampleSignedSwapTxB64(): string {
  const kp = Keypair.generate();
  const msg = new TransactionMessage({
    payerKey: kp.publicKey,
    recentBlockhash: "11111111111111111111111111111111",
    instructions: [
      SystemProgram.transfer({ fromPubkey: kp.publicKey, toPubkey: kp.publicKey, lamports: 0 }),
    ],
  }).compileToV0Message();
  const vtx = new VersionedTransaction(msg);
  vtx.sign([kp]);
  return globalThis.Buffer.from(vtx.serialize()).toString("base64");
}

function unsignedSwapTxB64(kp: Keypair): string {
  const msg = new TransactionMessage({
    payerKey: kp.publicKey,
    recentBlockhash: "11111111111111111111111111111111",
    instructions: [
      SystemProgram.transfer({ fromPubkey: kp.publicKey, toPubkey: kp.publicKey, lamports: 0 }),
    ],
  }).compileToV0Message();
  return globalThis.Buffer.from(new VersionedTransaction(msg).serialize()).toString("base64");
}

describe("executeJupiterSwap (Stage 5.4–5.5)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("simulateOnly does not call signTransaction or sendRawTransaction", async () => {
    vi.spyOn(jupiter, "fetchJupiterQuote").mockResolvedValue({ inAmount: "100" });
    vi.spyOn(jupiter, "fetchJupiterSwapTransaction").mockResolvedValue({ swapTransaction: sampleSignedSwapTxB64() });

    const signTransaction = vi.fn(async (tx: VersionedTransaction) => tx);
    const sendRawTransaction = vi.fn();

    const conn = {
      getLatestBlockhash: vi.fn().mockResolvedValue({ blockhash: "11111111111111111111111111111111", lastValidBlockHeight: 99 }),
      simulateTransaction: vi.fn().mockResolvedValue({ value: { err: null, logs: [] }, context: { slot: 1 } }),
      sendRawTransaction,
      confirmTransaction: vi.fn(),
    } as unknown as Connection;

    await executeJupiterSwap({
      connection: conn,
      userPublicKeyBase58: Keypair.generate().publicKey.toBase58(),
      quoteParams: {
        inputMint: "So11111111111111111111111111111111111111112",
        outputMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
        amount: 100n,
        slippageBps: 50,
      },
      rails: { killSwitchEngaged: false, maxInputRaw: 100n },
      signTransaction,
      simulateOnly: true,
    });

    expect(signTransaction).not.toHaveBeenCalled();
    expect(sendRawTransaction).not.toHaveBeenCalled();
  });

  it("throws before Jupiter when kill switch is engaged", async () => {
    const spyQuote = vi.spyOn(jupiter, "fetchJupiterQuote");
    await expect(
      executeJupiterSwap({
        connection: {} as Connection,
        userPublicKeyBase58: Keypair.generate().publicKey.toBase58(),
        quoteParams: {
          inputMint: "So11111111111111111111111111111111111111112",
          outputMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
          amount: 1n,
          slippageBps: 50,
        },
        rails: { killSwitchEngaged: true, maxInputRaw: 999n },
        signTransaction: async (tx) => tx,
        simulateOnly: true,
      }),
    ).rejects.toThrow(/KILL_SWITCH/);
    expect(spyQuote).not.toHaveBeenCalled();
  });

  it("broadcasts when simulateOnly is false and broadcast is true", async () => {
    const kp = Keypair.generate();
    vi.spyOn(jupiter, "fetchJupiterQuote").mockResolvedValue({ inAmount: "100" });
    vi.spyOn(jupiter, "fetchJupiterSwapTransaction").mockResolvedValue({ swapTransaction: unsignedSwapTxB64(kp) });

    const signTransaction = async (tx: VersionedTransaction) => {
      tx.sign([kp]);
      return tx;
    };

    const sendRawTransaction = vi.fn().mockResolvedValue("sig111");
    const confirmTransaction = vi.fn().mockResolvedValue({ value: { err: null }, context: { slot: 2 } });

    const conn = {
      getLatestBlockhash: vi.fn().mockResolvedValue({ blockhash: "11111111111111111111111111111111", lastValidBlockHeight: 99 }),
      simulateTransaction: vi.fn().mockResolvedValue({ value: { err: null, logs: [] }, context: { slot: 1 } }),
      sendRawTransaction,
      confirmTransaction,
    } as unknown as Connection;

    const res = await executeJupiterSwap({
      connection: conn,
      userPublicKeyBase58: kp.publicKey.toBase58(),
      quoteParams: {
        inputMint: "So11111111111111111111111111111111111111112",
        outputMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
        amount: 100n,
        slippageBps: 50,
      },
      rails: { killSwitchEngaged: false, maxInputRaw: 100n },
      signTransaction,
      simulateOnly: false,
      broadcast: { broadcast: true, skipPreflight: true, commitment: "processed" },
    });

    expect(sendRawTransaction).toHaveBeenCalledOnce();
    expect(res.signature).toBe("sig111");
  });
});
