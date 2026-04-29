import { describe, expect, it } from "vitest";
import { NATIVE_SOL_MINT } from "./types.js";
import {
  MAINNET_USDC_MINT,
  assertSplPartnerMintForSolPairs,
  describeSolPairPartnerShort,
  solPairSignalBuyQuote,
  solPairSignalSellExactInTokenQuote,
  solPairSignalSellExactSolOutQuote,
} from "./solPairSwapQuotes.js";

describe("solPairSwapQuotes", () => {
  it("builds SOL → USDC buy leg", () => {
    const q = solPairSignalBuyQuote(MAINNET_USDC_MINT, 1_000_000n, 100);
    expect(q.inputMint).toBe(NATIVE_SOL_MINT);
    expect(q.outputMint).toBe(MAINNET_USDC_MINT);
    expect(q.amount).toBe(1_000_000n);
    expect(q.swapMode).toBeUndefined();
  });

  it("builds USDC → SOL sell ExactOut leg", () => {
    const q = solPairSignalSellExactSolOutQuote(MAINNET_USDC_MINT, 2_000_000n, 80);
    expect(q.inputMint).toBe(MAINNET_USDC_MINT);
    expect(q.outputMint).toBe(NATIVE_SOL_MINT);
    expect(q.amount).toBe(2_000_000n);
    expect(q.swapMode).toBe("ExactOut");
  });

  it("builds generic SPL ExactIn sell fallback", () => {
    const mint = "Use1e55ssMINTxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";
    const q = solPairSignalSellExactInTokenQuote(mint, 999n, 100);
    expect(q.inputMint).toBe(mint);
    expect(q.outputMint).toBe(NATIVE_SOL_MINT);
    expect(q.amount).toBe(999n);
  });

  it("rejects wrapped SOL as partner mint", () => {
    expect(() => assertSplPartnerMintForSolPairs(NATIVE_SOL_MINT)).toThrow(/WRAPPED_SOL/);
  });

  it("describes USDC mint short label", () => {
    expect(describeSolPairPartnerShort(MAINNET_USDC_MINT)).toBe("USDC");
  });
});
