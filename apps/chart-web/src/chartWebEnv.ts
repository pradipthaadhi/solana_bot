import type { OperationalMode } from "@bot/scope/stage0.js";

export interface DeskEnv {
  rpcUrl: string;
  tokenMint: string;
  maxInputRaw: bigint;
  mode: OperationalMode;
  killSwitch: boolean;
  /** Lamports spent on each automated SIGNAL_ENTRY (ExactIn SOL → token). */
  signalBuyLamports: bigint;
  /** Raw token units sold on each SIGNAL_EXIT (ExactIn token → SOL). */
  signalSellTokenRaw: bigint;
  signalSlippageBps: number;
}

function parseMode(raw: string): OperationalMode {
  const m = raw.trim().toLowerCase();
  return m === "live" || m === "replay" || m === "paper" ? m : "paper";
}

function parseSlippageBps(raw: string | undefined): number {
  const n = Math.floor(Number(raw ?? "100"));
  if (!Number.isFinite(n) || n < 1 || n > 5000) {
    return 100;
  }
  return n;
}

export function readDeskEnv(): DeskEnv {
  const modeRaw = (import.meta.env.VITE_MODE ?? "paper").trim().toLowerCase();
  return {
    rpcUrl: (import.meta.env.VITE_RPC_URL ?? "https://api.mainnet-beta.solana.com").trim(),
    tokenMint: (import.meta.env.VITE_TOKEN_MINT ?? "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v").trim(),
    maxInputRaw: BigInt(import.meta.env.VITE_SOL_BOT_MAX_INPUT_RAW ?? "5000000"),
    mode: parseMode(modeRaw),
    killSwitch: import.meta.env.VITE_SOL_BOT_KILL_SWITCH === "1",
    signalBuyLamports: BigInt(import.meta.env.VITE_SIGNAL_BUY_LAMPORTS ?? "1000000"),
    signalSellTokenRaw: BigInt(import.meta.env.VITE_SIGNAL_SELL_TOKEN_RAW ?? "10000"),
    signalSlippageBps: parseSlippageBps(import.meta.env.VITE_SIGNAL_SLIPPAGE_BPS),
  };
}
