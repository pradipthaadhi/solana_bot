/**
 * Stage 5 — shared execution types (Jupiter + Solana RPC + signing).
 */

import type { Commitment } from "@solana/web3.js";
import type { OperationalMode } from "../scope/stage0.js";

export type SolanaCluster = "mainnet-beta" | "devnet";

/**
 * Jupiter Swap API v1 base (`GET …/quote`, `POST …/swap`).
 * @see https://dev.jup.ag/docs — public example host `https://api.jup.ag/swap/v1`.
 */
export const JUPITER_V6_QUOTE_API_DEFAULT = "https://api.jup.ag/swap/v1";

/** Wrapped SOL mint (mainnet / devnet same address). */
export const NATIVE_SOL_MINT = "So11111111111111111111111111111111111111112";

export type JupiterSwapMode = "ExactIn" | "ExactOut";

export interface JupiterQuoteParams {
  inputMint: string;
  outputMint: string;
  /**
   * `ExactIn` (default): raw units of `inputMint` to swap.
   * `ExactOut`: raw units of `outputMint` to receive (e.g. lamports of SOL when `outputMint` is wrapped SOL).
   */
  amount: bigint;
  slippageBps: number;
  /** Omit or `ExactIn` for standard quotes; `ExactOut` sets Jupiter `swapMode=ExactOut`. */
  swapMode?: JupiterSwapMode;
  /** When true, reduces routing complexity (useful in tests / debugging). */
  onlyDirectRoutes?: boolean;
}

export interface JupiterSwapRequest {
  quoteResponse: unknown;
  userPublicKeyBase58: string;
  wrapAndUnwrapSol?: boolean;
  dynamicComputeUnitLimit?: boolean;
  prioritizationFeeLamports?: "auto" | number;
}

export interface SafetyRails {
  /** When true, all swap sends are blocked (Stage 5.5). */
  killSwitchEngaged: boolean;
  /** Maximum input amount (base units) allowed for this leg. */
  maxInputRaw: bigint;
  /**
   * When set to `paper` or `replay`, {@link executeJupiterSwap} refuses on-chain broadcast even if the caller requests it.
   * Omit for backward-compatible “caller controls policy” behavior (tests / Model A UI).
   */
  operationalMode?: OperationalMode;
}

export interface BroadcastOptions {
  broadcast: boolean;
  skipPreflight?: boolean;
  commitment?: Commitment;
  maxRetries?: number;
}

export type SignVersionedTransaction = (tx: import("@solana/web3.js").VersionedTransaction) => Promise<import("@solana/web3.js").VersionedTransaction>;
