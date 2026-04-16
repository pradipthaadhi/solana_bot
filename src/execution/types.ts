/**
 * Stage 5 — shared execution types (Jupiter + Solana RPC + signing).
 */

import type { Commitment } from "@solana/web3.js";

export type SolanaCluster = "mainnet-beta" | "devnet";

/** Jupiter v6 quote API (legacy but stable for integrations). */
export const JUPITER_V6_QUOTE_API_DEFAULT = "https://quote-api.jup.ag/v6";

/** Wrapped SOL mint (mainnet / devnet same address). */
export const NATIVE_SOL_MINT = "So11111111111111111111111111111111111111112";

export interface JupiterQuoteParams {
  inputMint: string;
  outputMint: string;
  /** Raw base units (lamports for SOL / WSOL path). */
  amount: bigint;
  slippageBps: number;
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
}

export interface BroadcastOptions {
  broadcast: boolean;
  skipPreflight?: boolean;
  commitment?: Commitment;
  maxRetries?: number;
}

export type SignVersionedTransaction = (tx: import("@solana/web3.js").VersionedTransaction) => Promise<import("@solana/web3.js").VersionedTransaction>;
