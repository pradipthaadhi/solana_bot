import { Keypair, type Connection } from "@solana/web3.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createJupiterSignalExecutionAdapter } from "./jupiterExecutionAdapter.js";
import * as swapExecutor from "./swapExecutor.js";
import { NATIVE_SOL_MINT } from "./types.js";

describe("createJupiterSignalExecutionAdapter (Stage 5)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("maps BUY to SOL→target and SELL to target→SOL", async () => {
    const spy = vi.spyOn(swapExecutor, "executeJupiterSwap").mockResolvedValue({
      quote: {},
      simulation: { value: { err: null }, context: { slot: 1 } } as never,
    });
    const kp = Keypair.generate();
    const adapter = createJupiterSignalExecutionAdapter({
      connection: {} as Connection,
      userPublicKeyBase58: kp.publicKey.toBase58(),
      rails: { killSwitchEngaged: false, maxInputRaw: 10_000n },
      slippageBps: 50,
      targetMint: "TokenMint1111111111111111111111111111111111",
      buySpendLamports: 1_000n,
      sellTokenRaw: 2_000n,
      simulateOnly: true,
    });

    await adapter.onSignalEntry({ barIndex: 0, timeMs: 0, reason: "test" });
    expect(spy).toHaveBeenLastCalledWith(
      expect.objectContaining({
        quoteParams: expect.objectContaining({
          inputMint: NATIVE_SOL_MINT,
          outputMint: "TokenMint1111111111111111111111111111111111",
          amount: 1_000n,
        }),
      }),
    );

    await adapter.onSignalExit({ barIndex: 1, timeMs: 1, reason: "test" });
    expect(spy).toHaveBeenLastCalledWith(
      expect.objectContaining({
        quoteParams: expect.objectContaining({
          inputMint: "TokenMint1111111111111111111111111111111111",
          outputMint: NATIVE_SOL_MINT,
          amount: 2_000n,
        }),
      }),
    );
  });
});
