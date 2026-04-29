/**
 * SOL / SPL liquidity pools: signal BUY spends SOL for the pool’s non-SOL leg; signal SELL exits that leg back to SOL.
 * (For USDC/SOL: BUY = SOL → USDC, SELL = USDC → SOL.)
 */

import type { JupiterQuoteParams } from "./types.js";
import { NATIVE_SOL_MINT } from "./types.js";

/** Canonical SPL USDC on Solana mainnet (legacy mint). */
export const MAINNET_USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

export function normalizeNonSolPartnerMint(mint: string): string {
  return mint.trim();
}

/** Pool partner asset must be non-empty SPL mint and must not be wrapped SOL (same mint Jupiter uses for native SOL). */
export function assertSplPartnerMintForSolPairs(nonSolMint: string): void {
  const m = normalizeNonSolPartnerMint(nonSolMint);
  if (m.length === 0) {
    throw new Error("POOL_SWAP_MINT_EMPTY");
  }
  if (m === NATIVE_SOL_MINT) {
    throw new Error("POOL_SWAP_MINT_MUST_NOT_BE_WRAPPED_SOL");
  }
}

/** SIGNAL_ENTRY: ExactIn SOL → partner SPL (e.g. USDC, USELESS, …). */
export function solPairSignalBuyQuote(
  nonSolMint: string,
  spendSolLamports: bigint,
  slippageBps: number,
): JupiterQuoteParams {
  assertSplPartnerMintForSolPairs(nonSolMint);
  return {
    inputMint: NATIVE_SOL_MINT,
    outputMint: normalizeNonSolPartnerMint(nonSolMint),
    amount: spendSolLamports,
    slippageBps,
  };
}

/** SIGNAL_EXIT: ExactOut partner SPL → SOL (receive `targetSolOutLamports` of WSOL out). */
export function solPairSignalSellExactSolOutQuote(
  nonSolMint: string,
  targetSolOutLamports: bigint,
  slippageBps: number,
): JupiterQuoteParams {
  assertSplPartnerMintForSolPairs(nonSolMint);
  return {
    inputMint: normalizeNonSolPartnerMint(nonSolMint),
    outputMint: NATIVE_SOL_MINT,
    amount: targetSolOutLamports,
    slippageBps,
    swapMode: "ExactOut",
  };
}

/** Fallback SELL: ExactIn fixed partner SPL amount → SOL (best-effort when ExactOut fails). */
export function solPairSignalSellExactInTokenQuote(
  nonSolMint: string,
  partnerRawIn: bigint,
  slippageBps: number,
): JupiterQuoteParams {
  assertSplPartnerMintForSolPairs(nonSolMint);
  return {
    inputMint: normalizeNonSolPartnerMint(nonSolMint),
    outputMint: NATIVE_SOL_MINT,
    amount: partnerRawIn,
    slippageBps,
  };
}

export function describeSolPairPartnerShort(nonSolMint: string): string {
  const m = normalizeNonSolPartnerMint(nonSolMint);
  if (m === MAINNET_USDC_MINT) {
    return "USDC";
  }
  if (m.length <= 12) {
    return m;
  }
  return `${m.slice(0, 4)}…${m.slice(-4)}`;
}
