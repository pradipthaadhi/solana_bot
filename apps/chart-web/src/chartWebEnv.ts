import type { OperationalMode } from "@bot/scope/stage0.js";

export interface DeskEnv {
  rpcUrl: string;
  tokenMint: string;
  maxInputRaw: bigint;
  mode: OperationalMode;
  killSwitch: boolean;
  /** Lamports of SOL to spend on each SIGNAL_ENTRY (ExactIn SOL → x_token). 1e6 = 0.001 SOL. */
  signalBuyLamports: bigint;
  /** Lamports of SOL to receive on each SIGNAL_EXIT (ExactOut x_token → SOL). 1e6 = 0.001 SOL. */
  signalSellOutLamports: bigint;
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
    // x/SOL desk: set to the x_token mint (e.g. USELESS), not USDC, so BUY spends SOL for x and SELL returns SOL from x.
    tokenMint: (import.meta.env.VITE_TOKEN_MINT ?? "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v").trim(),
    maxInputRaw: BigInt(import.meta.env.VITE_SOL_BOT_MAX_INPUT_RAW ?? "5000000"),
    mode: parseMode(modeRaw),
    killSwitch: import.meta.env.VITE_SOL_BOT_KILL_SWITCH === "1",
    signalBuyLamports: BigInt(import.meta.env.VITE_SIGNAL_BUY_LAMPORTS ?? "1000000"),
    signalSellOutLamports: BigInt(
      import.meta.env.VITE_SIGNAL_SELL_OUT_LAMPORTS?.trim() ||
        import.meta.env.VITE_SIGNAL_BUY_LAMPORTS?.trim() ||
        "1000000",
    ),
    signalSlippageBps: parseSlippageBps(import.meta.env.VITE_SIGNAL_SLIPPAGE_BPS),
  };
}
