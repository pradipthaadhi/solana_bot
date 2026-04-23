import type { ExecutionAdapter, ExecutionSignalPayload } from "@bot/agent/executionAdapter.js";
import { createDedupingExecutionAdapter } from "@bot/agent/executionAdapter.js";
import { createKeypairSigner } from "@bot/execution/keypairSigner.js";
import { executeJupiterSwap } from "@bot/execution/swapExecutor.js";
import { NATIVE_SOL_MINT } from "@bot/execution/types.js";
import { Connection } from "@solana/web3.js";
import { appendPosition, type PositionSignalRow } from "./positionsLog.js";
import { readDeskEnv } from "./chartWebEnv.js";
import { resolveJupiterApiBaseUrl } from "./jupiterApiBaseUrl.js";
import { getSessionTradingKeypair } from "./sessionTradingKey.js";
import { getSessionPoolSwapTokenMint } from "./sessionPoolSwapMint.js";
import { getSignalAutoTradeLamports } from "./signalTradeAmount.js";
import {
  chartToastBuySignalDone,
  chartToastError,
  chartToastSellSignalDone,
} from "./chartToaster.js";
import { notifyDesktop } from "./notify.js";

function buildRow(
  side: PositionSignalRow["side"],
  pairLabel: string,
  poolAddress: string,
  p: ExecutionSignalPayload,
): PositionSignalRow {
  return {
    ts: new Date(p.timeMs).toISOString(),
    side,
    pair: pairLabel,
    pool: poolAddress,
    barIndex: p.barIndex,
    reason: p.reason,
  };
}

function innerAutoAdapter(pairLabel: string, poolAddress: string, onPersisted: () => void): ExecutionAdapter {
  const deskEnv = readDeskEnv();

  const maybeSwap = async (
    side: "BUY" | "SELL",
    row: PositionSignalRow,
  ): Promise<PositionSignalRow> => {
    const kp = getSessionTradingKeypair();
    if (kp === null) {
      return {
        ...row,
        txStatus: "skipped",
        txDetail:
          "No signing key — set a valid VITE_DESK_PRIVATE_KEY in apps/chart-web/.env and restart the dev server (or rebuild).",
      };
    }
    if (deskEnv.killSwitch) {
      return { ...row, txStatus: "skipped", txDetail: "Kill switch is on (VITE_SOL_BOT_KILL_SWITCH=1)." };
    }
    if (deskEnv.mode !== "live") {
      return {
        ...row,
        txStatus: "skipped",
        txDetail: `VITE_MODE=${deskEnv.mode} — set VITE_MODE=live to broadcast auto-swaps.`,
      };
    }
    const tokenMint = getSessionPoolSwapTokenMint(deskEnv.tokenMint).trim();
    if (tokenMint.length === 0) {
      return {
        ...row,
        txStatus: "skipped",
        txDetail:
          "No token mint: load the pool (Gecko should supply base/quote, including x/SOL) or set VITE_TOKEN_MINT in .env.",
      };
    }

    const am = getSignalAutoTradeLamports();
    if (!am.ok) {
      return { ...row, txStatus: "skipped", txDetail: `Auto-signal size: ${am.error}` };
    }
    const buyLamports = am.buy;
    const sellLamports = am.sell;

    const conn = new Connection(deskEnv.rpcUrl, {
      commitment: "confirmed",
      confirmTransactionInitialTimeout: 90_000,
    });
    const signTransaction = createKeypairSigner(kp);
    const rails = {
      killSwitchEngaged: deskEnv.killSwitch,
      maxInputRaw: deskEnv.maxInputRaw,
      operationalMode: deskEnv.mode,
    };

    try {
      if (side === "BUY") {
        const res = await executeJupiterSwap({
          connection: conn,
          userPublicKeyBase58: kp.publicKey.toBase58(),
          quoteParams: {
            inputMint: NATIVE_SOL_MINT,
            outputMint: tokenMint,
            amount: buyLamports,
            slippageBps: deskEnv.signalSlippageBps,
          },
          rails,
          signTransaction,
          simulateOnly: false,
          jupiterBaseUrl: resolveJupiterApiBaseUrl(),
          skipRpcHealthCheck: true,
        });
        const sig = res.signature ?? "";
        return {
          ...row,
          txStatus: "ok",
          signature: sig,
          txDetail: sig ? `Confirmed · ${sig.slice(0, 8)}…` : "Confirmed",
        };
      }
      const res = await executeJupiterSwap({
        connection: conn,
        userPublicKeyBase58: kp.publicKey.toBase58(),
        quoteParams: {
          inputMint: tokenMint,
          outputMint: NATIVE_SOL_MINT,
          amount: sellLamports,
          slippageBps: deskEnv.signalSlippageBps,
          swapMode: "ExactOut",
        },
        rails,
        signTransaction,
        simulateOnly: false,
        jupiterBaseUrl: resolveJupiterApiBaseUrl(),
        skipRpcHealthCheck: true,
      });
      const sig = res.signature ?? "";
      return {
        ...row,
        txStatus: "ok",
        signature: sig,
        txDetail: sig ? `Confirmed · ${sig.slice(0, 8)}…` : "Confirmed",
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { ...row, txStatus: "error", txDetail: msg };
    }
  };

  return {
    async onSignalEntry(p: ExecutionSignalPayload) {
      const row = buildRow("BUY", pairLabel, poolAddress, p);
      const finalRow = await maybeSwap("BUY", row);
      await appendPosition(finalRow);
      onPersisted();
      const msg = `${p.reason}\n${row.ts}`;
      notifyDesktop(`${pairLabel} — BUY`, msg);
      if (finalRow.txStatus === "error") {
        chartToastError("Auto BUY failed", finalRow.txDetail ?? "Unknown error", 16_000);
      }
      chartToastBuySignalDone(pairLabel, p.reason, row.ts);
    },
    async onSignalExit(p: ExecutionSignalPayload) {
      const row = buildRow("SELL", pairLabel, poolAddress, p);
      const finalRow = await maybeSwap("SELL", row);
      await appendPosition(finalRow);
      onPersisted();
      const msg = `${p.reason}\n${row.ts}`;
      notifyDesktop(`${pairLabel} — SELL`, msg);
      if (finalRow.txStatus === "error") {
        chartToastError("Auto SELL failed", finalRow.txDetail ?? "Unknown error", 16_000);
      }
      chartToastSellSignalDone(pairLabel, p.reason, row.ts);
    },
  };
}

/**
 * Deduped ENTRY/EXIT hooks: notify, persist row with tx outcome, optional Jupiter broadcast when policy allows.
 */
export function createAutoSwapExecutionAdapter(
  pairLabel: string,
  poolAddress: string,
  dedupeSeen: Set<string>,
  onPersisted: () => void,
): ExecutionAdapter {
  return createDedupingExecutionAdapter(innerAutoAdapter(pairLabel, poolAddress, onPersisted), dedupeSeen);
}
