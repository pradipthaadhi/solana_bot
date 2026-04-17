/**
 * Stage 5.4–5.5 — Jupiter v6 quote → swap transaction → simulate → optional broadcast.
 * Jupiter routing is **mainnet-centric**; use a mainnet RPC endpoint in production.
 *
 * @see docs/STAGE8_RISK_AND_COMPLIANCE.md — execution risk, caps, and responsible use (not legal advice).
 */

import {
  Connection,
  VersionedTransaction,
  type RpcResponseAndContext,
  type SimulatedTransactionResponse,
} from "@solana/web3.js";
import { assertRpcHealthy } from "./rpcHealth.js";
import { assertOnChainBroadcastAllowed, assertTradingAllowed, assertWithinMaxInput } from "./safetyRails.js";
import { fetchJupiterQuote, fetchJupiterSwapTransaction, readQuotedInputAmount } from "./jupiterClient.js";
import type { BroadcastOptions, JupiterQuoteParams, SafetyRails, SignVersionedTransaction } from "./types.js";

export interface ExecuteJupiterSwapParams {
  connection: Connection;
  userPublicKeyBase58: string;
  quoteParams: JupiterQuoteParams;
  rails: SafetyRails;
  signTransaction: SignVersionedTransaction;
  /** When true, stops after simulation (no wallet sign, no broadcast). */
  simulateOnly: boolean;
  broadcast?: BroadcastOptions;
  jupiterBaseUrl?: string;
  fetchFn?: typeof fetch;
  signal?: AbortSignal;
}

export interface ExecuteJupiterSwapResult {
  quote: unknown;
  simulation: RpcResponseAndContext<SimulatedTransactionResponse>;
  /** Present when `simulateOnly` is false and broadcast succeeds. */
  signature?: string;
}

function toBufferFromSwapTxBase64(b64: string): Uint8Array {
  if (typeof globalThis.Buffer !== "undefined") {
    return globalThis.Buffer.from(b64, "base64");
  }
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

/**
 * Full pipeline: quote → safety (from quote inAmount) → RPC health → swap tx → simulate → (sign → send).
 */
function pickJupiterOpts(params: ExecuteJupiterSwapParams): {
  baseUrl?: string;
  fetchFn?: typeof fetch;
  signal?: AbortSignal;
} {
  return {
    ...(params.jupiterBaseUrl !== undefined ? { baseUrl: params.jupiterBaseUrl } : {}),
    ...(params.fetchFn !== undefined ? { fetchFn: params.fetchFn } : {}),
    ...(params.signal !== undefined ? { signal: params.signal } : {}),
  };
}

export async function executeJupiterSwap(params: ExecuteJupiterSwapParams): Promise<ExecuteJupiterSwapResult> {
  assertTradingAllowed(params.rails);
  assertWithinMaxInput(params.quoteParams.amount, params.rails.maxInputRaw);

  const jupiterOpts = pickJupiterOpts(params);
  const quote = await fetchJupiterQuote(params.quoteParams, jupiterOpts);
  const quotedIn = readQuotedInputAmount(quote);
  assertWithinMaxInput(quotedIn, params.rails.maxInputRaw);

  await assertRpcHealthy(params.connection);

  const { swapTransaction } = await fetchJupiterSwapTransaction(
    {
      quoteResponse: quote,
      userPublicKeyBase58: params.userPublicKeyBase58,
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: "auto",
    },
    jupiterOpts,
  );

  const bytes = toBufferFromSwapTxBase64(swapTransaction);
  const tx = VersionedTransaction.deserialize(bytes);

  const simulation = await params.connection.simulateTransaction(tx, {
    sigVerify: false,
    commitment: "processed",
    replaceRecentBlockhash: true,
  });
  if (simulation.value.err) {
    const logs = simulation.value.logs?.join("\n") ?? "";
    throw new Error(`SIMULATION_FAILED: ${JSON.stringify(simulation.value.err)}\n${logs}`);
  }

  if (params.simulateOnly) {
    return { quote, simulation };
  }

  const bc = params.broadcast ?? { broadcast: true };
  assertOnChainBroadcastAllowed(params.rails, bc.broadcast);

  const signed = await params.signTransaction(tx);

  if (!bc.broadcast) {
    return { quote, simulation };
  }

  const skipPreflight = bc.skipPreflight ?? false;
  const commitment = bc.commitment ?? "confirmed";
  const maxRetries = bc.maxRetries ?? 3;

  const signature = await params.connection.sendRawTransaction(signed.serialize(), {
    skipPreflight,
    maxRetries,
    preflightCommitment: commitment,
  });

  const latest = await params.connection.getLatestBlockhash(commitment);
  const confirmation = await params.connection.confirmTransaction(
    {
      signature,
      blockhash: latest.blockhash,
      lastValidBlockHeight: latest.lastValidBlockHeight,
    },
    commitment,
  );
  if (confirmation.value.err) {
    throw new Error(`CONFIRMATION_FAILED: ${JSON.stringify(confirmation.value.err)}`);
  }

  return { quote, simulation, signature };
}

/**
 * Build an **unsigned** VersionedTransaction from a Jupiter swap base64 payload (for wallet preview / Phantom).
 */
export function deserializeJupiterSwapTransactionBase64(swapTransactionBase64: string): VersionedTransaction {
  const bytes = toBufferFromSwapTxBase64(swapTransactionBase64);
  return VersionedTransaction.deserialize(bytes);
}
