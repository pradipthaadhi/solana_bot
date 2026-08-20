import type { ExecutionAdapter, ExecutionSignalPayload } from "@bot/agent/executionAdapter.js";
import { createDedupingExecutionAdapter } from "@bot/agent/executionAdapter.js";
import { createKeypairSigner } from "@bot/execution/keypairSigner.js";
import { executeJupiterSwap } from "@bot/execution/swapExecutor.js";
import {
  assertSplPartnerMintForSolPairs,
  solPairSignalBuyQuote,
  solPairSignalSellExactInTokenQuote,
  solPairSignalSellExactSolOutQuote,
} from "@bot/execution/solPairSwapQuotes.js";
import { Connection, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { appendPosition, type PositionSignalRow } from "./positionsLog.js";
import { readDeskEnv } from "./chartWebEnv.js";
import { resolveJupiterApiBaseUrl } from "./jupiterApiBaseUrl.js";
import { getSessionTradingKeypair } from "./sessionTradingKey.js";
import { getSessionPoolSwapTokenMint } from "./sessionPoolSwapMint.js";
import {
  newTradeId,
  onBuyFilledPool,
  onSellFilledPool,
  peekOpenBuyTradeIdForPool,
  releaseOpenBuyIfMatches,
  tryReserveOpenBuyForPool,
} from "./sessionTradePairing.js";
import { getSignalAutoTradeLamports } from "./signalTradeAmount.js";
import { readWalletSplTokenBalanceRaw } from "./splTokenBalance.js";
import {
  chartToastBuySignalDone,
  chartToastError,
  chartToastInfo,
  chartToastSellSignalDone,
} from "./chartToaster.js";
import { notifyDesktop } from "./notify.js";

/** Post-trade balance snapshot for the wallet-balance chart; a read failure must not fail the trade row. */
async function sampleWalletBalanceSol(conn: Connection, owner: Parameters<Connection["getBalance"]>[0]): Promise<number | undefined> {
  try {
    const lamports = await conn.getBalance(owner);
    return lamports / LAMPORTS_PER_SOL;
  } catch {
    return undefined;
  }
}

/** ExactOut (target SOL) can quote more x_token input than the wallet holds; sim then fails with SPL 0x1 "insufficient funds". */
function isSellInsufficientError(message: string): boolean {
  return (
    message.includes("INSUFFICIENT_TOKEN_BALANCE") ||
    /insufficient funds/i.test(message) ||
    /custom program error: 0x1/i.test(message)
  );
}

/**
 * Some AMM programs only implement swap-exact-tokens-in at the on-chain level, not
 * swap-for-exact-tokens-out — Jupiter's ExactOut quote for that pair 400s with "no route" even
 * though an ExactIn quote (spend the token balance, take whatever SOL comes out) would route fine.
 * Distinct from {@link isSellInsufficientError}: not a balance problem, a routing-mode problem —
 * still worth the same ExactIn retry, just for a different reason.
 */
function isNoRouteFoundError(message: string): boolean {
  return (
    /no routes? found/i.test(message) ||
    message.includes("NO_ROUTES_FOUND") ||
    message.includes("COULD_NOT_FIND_ANY_ROUTE")
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
          "No token mint: load the pool (GeckoTerminal meta supplies base/quote mints for x/SOL) or set VITE_TOKEN_MINT in .env.",
      };
    }
    try {
      assertSplPartnerMintForSolPairs(tokenMint);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return {
        ...row,
        txStatus: "skipped",
        txDetail: `Invalid pool swap mint (${msg}). Expected the pool’s non-SOL SPL mint (e.g. USDC for SOL/USDC).`,
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
          quoteParams: solPairSignalBuyQuote(tokenMint, buyLamports, deskEnv.signalSlippageBps),
          rails,
          signTransaction,
          simulateOnly: false,
          jupiterBaseUrl: resolveJupiterApiBaseUrl(),
          skipRpcHealthCheck: true,
        });
        const sig = res.signature ?? "";
        const walletBalanceSol = await sampleWalletBalanceSol(conn, kp.publicKey);
        return {
          ...row,
          txStatus: "ok",
          signature: sig,
          txDetail: sig ? `Confirmed · ${sig.slice(0, 8)}…` : "Confirmed",
          ...(walletBalanceSol !== undefined ? { walletBalanceSol } : {}),
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

      const okRow = async (res: { signature?: string }, extraDetail = ""): Promise<PositionSignalRow> => {
        const sig = res.signature ?? "";
        const walletBalanceSol = await sampleWalletBalanceSol(conn, kp.publicKey);
        return {
          ...row,
          txStatus: "ok",
          signature: sig,
          txDetail: sig
            ? `Confirmed · ${sig.slice(0, 8)}…${extraDetail}`
            : `Confirmed${extraDetail}`,
          ...(walletBalanceSol !== undefined ? { walletBalanceSol } : {}),
        };
      };

      try {
        return await okRow(
          await executeJupiterSwap({
            ...swapBase,
            quoteParams: solPairSignalSellExactSolOutQuote(tokenMint, sellLamports, deskEnv.signalSlippageBps),
            preflightSplBalanceRaw: splBalance,
          }),
        );
      } catch (first) {
        const firstMsg = first instanceof Error ? first.message : String(first);
        const noRoute = isNoRouteFoundError(firstMsg);
        if ((!isSellInsufficientError(firstMsg) && !noRoute) || maxTokenIn < 1n) {
          return { ...row, txStatus: "error", txDetail: firstMsg };
        }
        const res = await executeJupiterSwap({
          ...swapBase,
          quoteParams: solPairSignalSellExactInTokenQuote(tokenMint, maxTokenIn, deskEnv.signalSlippageBps),
        });
        return await okRow(
          res,
          noRoute
            ? " — ExactOut had no route for this pair; retried as ExactIn (sold spendable token balance)."
            : " — sold spendable token balance (ExactOut target needed more x than the wallet had).",
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
      if (!tryReserveOpenBuyForPool(poolAddress, buyId)) {
        const row = buildRow("BUY", pairLabel, poolAddress, p, buyId);
        const finalRow: PositionSignalRow = {
          ...row,
          txStatus: "skipped",
          txDetail:
            "Open position already (or a BUY is in flight) — no new entry until a successful SELL for this pool. One at a time.",
        };
        await appendPosition(finalRow);
        onPersisted();
        chartToastInfo("BUY skipped (one open position)", finalRow.txDetail ?? "");
        return;
      }
      const row = buildRow("BUY", pairLabel, poolAddress, p, buyId);
      const finalRow = await maybeSwap("BUY", row);
      if (finalRow.txStatus !== "ok") {
        releaseOpenBuyIfMatches(poolAddress, buyId);
      } else {
        onBuyFilledPool(poolAddress, buyId);
      }
      await appendPosition(finalRow);
      onPersisted();
      const msg = `${p.reason}\n${row.ts}`;
      notifyDesktop(`${pairLabel} — BUY`, msg);
      if (finalRow.txStatus === "error") {
        chartToastError("Auto BUY failed", finalRow.txDetail ?? "Unknown error");
      } else if (finalRow.txStatus === "skipped" && (finalRow.txDetail?.includes("Open position") ?? false)) {
        chartToastInfo("BUY skipped (one open position)", finalRow.txDetail ?? "");
      } else {
        chartToastBuySignalDone(pairLabel, p.reason, row.ts);
      }
    },
    async onSignalExit(p: ExecutionSignalPayload) {
      const sellRef = peekOpenBuyTradeIdForPool(poolAddress);
      if (sellRef.length === 0) {
        // The strategy FSM re-evaluates FLAT/ARMED/LONG purely from chart data every tick, with
        // no knowledge of whether the matching BUY actually landed on-chain. Without this guard,
        // an exit cross after a BUY that errored (or already got sold) would still attempt a
        // SELL — and `maybeSwap` only refuses on a literal zero token balance, so it would happily
        // sell whatever balance happens to be sitting in the wallet (leftover from an earlier,
        // unrelated position) instead of skipping. That's how BUY(error)->SELL(success) shows up
        // in the log: a "successful" sell of tokens this signal never bought. Only sell a position
        // auto-trading itself tracks as open, so BUY/SELL stays strictly paired: BUY1-SELL1-BUY2-SELL2.
        const row = buildRow("SELL", pairLabel, poolAddress, p);
        const finalRow: PositionSignalRow = {
          ...row,
          txStatus: "skipped",
          txDetail: "No open position tracked for this pool — nothing this signal bought is still open, skipping SELL.",
        };
        await appendPosition(finalRow);
        onPersisted();
        chartToastInfo("SELL skipped (no open position)", finalRow.txDetail ?? "");
        return;
      }
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
