/**
 * Stage 5.4–5.5 — Jupiter quote → swap transaction → simulate → optional broadcast.
 * Jupiter routing is **mainnet-centric**; use a mainnet RPC endpoint in production.
 *
 * @see docs/STAGE8_RISK_AND_COMPLIANCE.md — execution risk, caps, and responsible use (not legal advice).
 */

import {
  AddressLookupTableAccount,
  Connection,
  TransactionMessage,
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
  /**
   * When set, after quote ensures Jupiter `inAmount` does not exceed this balance (same mint as `quoteParams.inputMint`).
   * Use on token→SOL sells to reject before swap build when the wallet cannot fund the quoted input.
   */
  preflightSplBalanceRaw?: bigint;
  /**
   * When true, skips `getSlot` RPC liveness check (browser + public RPC often stalls or 403s).
   * `simulateTransaction` still validates the endpoint. Prefer false for headless / paid RPC.
   */
  skipRpcHealthCheck?: boolean;
  /** Override default RPC health timeout (ms). */
  rpcHealthTimeoutMs?: number;
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
 * Jupiter embeds a `recentBlockhash` at swap-build time; it is often stale before RPC simulation.
 * `@solana/web3.js` `simulateTransaction(VersionedTransaction, { replaceRecentBlockhash: true })` does **not**
 * forward `replaceRecentBlockhash` to the RPC (only `encoding` / `commitment` / `innerInstructions`), so we must
 * rebuild the v0 message with `getLatestBlockhash` from the same `Connection` used to simulate/send.
 */
async function versionedTransactionWithLatestBlockhash(
  connection: Connection,
  tx: VersionedTransaction,
): Promise<VersionedTransaction> {
  const msg = tx.message;
  const lookups = "addressTableLookups" in msg ? (msg.addressTableLookups ?? []) : [];
  let addressLookupTableAccounts: AddressLookupTableAccount[] = [];
  if (lookups.length > 0) {
    const loaded = await Promise.all(
      lookups.map((lookup) =>
        connection.getAddressLookupTable(lookup.accountKey, { commitment: "confirmed" }),
      ),
    );
    addressLookupTableAccounts = loaded
      .map((r) => r.value)
      .filter((a): a is AddressLookupTableAccount => a !== null);
    if (addressLookupTableAccounts.length !== lookups.length) {
      throw new Error(
        "SIMULATION_SETUP: could not load all address lookup tables from RPC (needed to refresh blockhash).",
      );
    }
  }

  const decompiled =
    addressLookupTableAccounts.length > 0
      ? TransactionMessage.decompile(msg, { addressLookupTableAccounts })
      : TransactionMessage.decompile(msg);

  const { blockhash } = await connection.getLatestBlockhash("confirmed");
  const compiled = new TransactionMessage({
    payerKey: decompiled.payerKey,
    recentBlockhash: blockhash,
    instructions: decompiled.instructions,
  }).compileToV0Message(addressLookupTableAccounts.length > 0 ? addressLookupTableAccounts : undefined);

  return new VersionedTransaction(compiled);
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
  /** For ExactOut, `amount` is output-side units, not wallet spend — cap applies to quoted `inAmount` only. */
  if (params.quoteParams.swapMode !== "ExactOut") {
    assertWithinMaxInput(params.quoteParams.amount, params.rails.maxInputRaw);
  }

  const jupiterOpts = pickJupiterOpts(params);
  const quote = await fetchJupiterQuote(params.quoteParams, jupiterOpts);
  const quotedIn = readQuotedInputAmount(quote);
  assertWithinMaxInput(quotedIn, params.rails.maxInputRaw);
  if (params.preflightSplBalanceRaw !== undefined && quotedIn > params.preflightSplBalanceRaw) {
    throw new Error(
      `INSUFFICIENT_TOKEN_BALANCE: need ${quotedIn.toString()} raw units of input mint, wallet has ${params.preflightSplBalanceRaw.toString()}. ` +
        "Add more of the sell token or lower the target SOL out (lamports).",
    );
  }

  if (params.skipRpcHealthCheck !== true) {
    await assertRpcHealthy(params.connection, params.rpcHealthTimeoutMs);
  }

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
  let tx = VersionedTransaction.deserialize(bytes);
  tx = await versionedTransactionWithLatestBlockhash(params.connection, tx);

  const simulation = await params.connection.simulateTransaction(tx, {
    commitment: "confirmed",
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

  tx = await versionedTransactionWithLatestBlockhash(params.connection, tx);
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
