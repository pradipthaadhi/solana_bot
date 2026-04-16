/**
 * Stage 5 — bridge FSM execution hooks → Jupiter legs (BUY = SOL→token, SELL = token→SOL).
 */

import type { Connection } from "@solana/web3.js";
import type { ExecutionAdapter, ExecutionSignalPayload } from "../agent/executionAdapter.js";
import { executeJupiterSwap } from "./swapExecutor.js";
import type { JupiterQuoteParams, SafetyRails, SignVersionedTransaction } from "./types.js";
import { NATIVE_SOL_MINT } from "./types.js";

export interface JupiterSignalExecutionAdapterConfig {
  connection: Connection;
  userPublicKeyBase58: string;
  signTransaction: SignVersionedTransaction;
  rails: SafetyRails;
  slippageBps: number;
  /** SPL mint to accumulate on BUY / reduce on SELL. */
  targetMint: string;
  /** Lamports of WSOL to spend on each BUY signal (ExactIn). */
  buySpendLamports: bigint;
  /** Raw token amount to sell on each SELL signal (ExactIn). */
  sellTokenRaw: bigint;
  simulateOnly: boolean;
  jupiterBaseUrl?: string;
  fetchFn?: typeof fetch;
}

export function createJupiterSignalExecutionAdapter(cfg: JupiterSignalExecutionAdapterConfig): ExecutionAdapter {
  const execOpts = {
    connection: cfg.connection,
    userPublicKeyBase58: cfg.userPublicKeyBase58,
    rails: cfg.rails,
    signTransaction: cfg.signTransaction,
    simulateOnly: cfg.simulateOnly,
    ...(cfg.jupiterBaseUrl !== undefined ? { jupiterBaseUrl: cfg.jupiterBaseUrl } : {}),
    ...(cfg.fetchFn !== undefined ? { fetchFn: cfg.fetchFn } : {}),
  };
  return {
    async onSignalEntry(_p: ExecutionSignalPayload) {
      const quoteParams: JupiterQuoteParams = {
        inputMint: NATIVE_SOL_MINT,
        outputMint: cfg.targetMint,
        amount: cfg.buySpendLamports,
        slippageBps: cfg.slippageBps,
      };
      await executeJupiterSwap({
        ...execOpts,
        quoteParams,
      });
    },
    async onSignalExit(_p: ExecutionSignalPayload) {
      const quoteParams: JupiterQuoteParams = {
        inputMint: cfg.targetMint,
        outputMint: NATIVE_SOL_MINT,
        amount: cfg.sellTokenRaw,
        slippageBps: cfg.slippageBps,
      };
      await executeJupiterSwap({
        ...execOpts,
        quoteParams,
      });
    },
  };
}
