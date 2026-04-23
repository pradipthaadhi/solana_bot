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
import { newTradeId, onBuyFilledPool, onSellFilledPool, peekOpenBuyTradeIdForPool } from "./sessionTradePairing.js";
import { getSignalAutoTradeLamports } from "./signalTradeAmount.js";
import { readWalletSplTokenBalanceRaw } from "./splTokenBalance.js";
import {
  chartToastBuySignalDone,
  chartToastError,
  chartToastSellSignalDone,
} from "./chartToaster.js";
import { notifyDesktop } from "./notify.js";

/** ExactOut (target SOL) can quote more x_token input than the wallet holds; sim then fails with SPL 0x1 "insufficient funds". */
function isSellInsufficientError(message: string): boolean {
  return (
    message.includes("INSUFFICIENT_TOKEN_BALANCE") ||
    /insufficient funds/i.test(message) ||
    /custom program error: 0x1/i.test(message)
  );
}

function buildRow(
  side: PositionSignalRow["side"],
  pairLabel: string,
  poolAddress: string,
  p: ExecutionSignalPayload,
  /** BUY: new id; SELL: id of the open BUY (FIFO) this exit closes, if any. */
  tradeId?: string,
): PositionSignalRow {
  const r: PositionSignalRow = {
    ts: new Date(p.timeMs).toISOString(),
    side,
    pair: pairLabel,
    pool: poolAddress,
    barIndex: p.barIndex,
    reason: p.reason,
  };
  if (tradeId !== undefined && tradeId.length > 0) {
    r.tradeId = tradeId;
  }
  return r;
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
      const splBalance = await readWalletSplTokenBalanceRaw(conn, kp.publicKey, tokenMint);
      if (splBalance === 0n) {
        return {
          ...row,
          txStatus: "skipped",
          txDetail: "No token balance to sell (desk wallet holds 0 of this mint).",
        };
      }
      const maxTokenIn = splBalance < deskEnv.maxInputRaw ? splBalance : deskEnv.maxInputRaw;
      const swapBase = {
        connection: conn,
        userPublicKeyBase58: kp.publicKey.toBase58(),
        rails,
        signTransaction,
        simulateOnly: false,
        jupiterBaseUrl: resolveJupiterApiBaseUrl(),
        skipRpcHealthCheck: true,
      } as const;

      const okRow = (res: { signature?: string }, extraDetail = ""): PositionSignalRow => {
        const sig = res.signature ?? "";
        return {
          ...row,
          txStatus: "ok",
          signature: sig,
          txDetail: sig
            ? `Confirmed · ${sig.slice(0, 8)}…${extraDetail}`
            : `Confirmed${extraDetail}`,
        };
      };

      try {
        return okRow(
          await executeJupiterSwap({
            ...swapBase,
            quoteParams: {
              inputMint: tokenMint,
              outputMint: NATIVE_SOL_MINT,
              amount: sellLamports,
              slippageBps: deskEnv.signalSlippageBps,
              swapMode: "ExactOut",
            },
            preflightSplBalanceRaw: splBalance,
          }),
        );
      } catch (first) {
        const firstMsg = first instanceof Error ? first.message : String(first);
        if (!isSellInsufficientError(firstMsg) || maxTokenIn < 1n) {
          return { ...row, txStatus: "error", txDetail: firstMsg };
        }
        const res = await executeJupiterSwap({
          ...swapBase,
          quoteParams: {
            inputMint: tokenMint,
            outputMint: NATIVE_SOL_MINT,
            amount: maxTokenIn,
            slippageBps: deskEnv.signalSlippageBps,
          },
        });
        return okRow(
          res,
          " — sold spendable token balance (ExactOut target needed more x than the wallet had).",
        );
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { ...row, txStatus: "error", txDetail: msg };
    }
  };

  return {
    async onSignalEntry(p: ExecutionSignalPayload) {
      const buyId = newTradeId();
      const row = buildRow("BUY", pairLabel, poolAddress, p, buyId);
      const finalRow = await maybeSwap("BUY", row);
      if (finalRow.txStatus === "ok") {
        onBuyFilledPool(poolAddress, buyId);
      }
      await appendPosition(finalRow);
      onPersisted();
      const msg = `${p.reason}\n${row.ts}`;
      notifyDesktop(`${pairLabel} — BUY`, msg);
      if (finalRow.txStatus === "error") {
        chartToastError("Auto BUY failed", finalRow.txDetail ?? "Unknown error");
      }
      chartToastBuySignalDone(pairLabel, p.reason, row.ts);
    },
    async onSignalExit(p: ExecutionSignalPayload) {
      const sellRef = peekOpenBuyTradeIdForPool(poolAddress);
      const row = buildRow("SELL", pairLabel, poolAddress, p, sellRef);
      const finalRow = await maybeSwap("SELL", row);
      if (finalRow.txStatus === "ok") {
        onSellFilledPool(poolAddress);
      }
      await appendPosition(finalRow);
      onPersisted();
      const msg = `${p.reason}\n${row.ts}`;
      notifyDesktop(`${pairLabel} — SELL`, msg);
      if (finalRow.txStatus === "error") {
        chartToastError("Auto SELL failed", finalRow.txDetail ?? "Unknown error");
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
