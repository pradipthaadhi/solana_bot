/**
 * Wire `SignalAgent` + deduped `createJupiterSignalExecutionAdapter` for headless signal execution.
 */

import { SignalAgent, type ComputeIndicatorsFn, type SignalAgentParams } from "../agent/signalAgent.js";
import { createDedupingExecutionAdapter } from "../agent/executionAdapter.js";
import type { BotEnv } from "../config/botEnv.js";
import { buildSafetyRailsFromBotEnv } from "../config/botEnv.js";
import { createJupiterSignalExecutionAdapter } from "../execution/jupiterExecutionAdapter.js";
import type { ExecuteJupiterSwapResult } from "../execution/swapExecutor.js";
import { createKeypairSigner } from "../execution/keypairSigner.js";
import type { Connection, Keypair } from "@solana/web3.js";
import { DEFAULT_STRATEGY_CONFIG, type StrategyConfig } from "../strategy/strategyConfig.js";
import type { HeadlessSignalExecConfig } from "./headlessSignalEnv.js";

export interface HeadlessJupiterAgentDeps {
  connection: Connection;
  keypair: Keypair;
  /** Optional hook after each Jupiter leg (logging, metrics). */
  onSwapComplete?: (result: ExecuteJupiterSwapResult, leg: "entry" | "exit") => void | Promise<void>;
  strategy?: StrategyConfig;
  /** Override indicator pipeline (tests / custom series). */
  computeIndicators?: ComputeIndicatorsFn;
  /** Match chart-web tail lookback for `TWO_GREEN_ABOVE_VWAP` entry timing. */
  executionTailBarLookback?: number;
  /** Structured log sink (default: JSON lines to console). */
  log?: SignalAgentParams["log"];
}

/**
 * Build a {@link SignalAgent} that runs Jupiter swaps on tail `SIGNAL_ENTRY` / `SIGNAL_EXIT` hooks.
 *
 * - **Deduping** prevents repeated swaps when the same signal remains inside the tail window each poll.
 * - **Real sends** require `MODE=live` and `simulateOnly: false` (see {@link assertHeadlessExecPolicy}).
 */
export function createHeadlessJupiterSignalAgent(
  bot: BotEnv,
  exec: HeadlessSignalExecConfig,
  deps: HeadlessJupiterAgentDeps,
): SignalAgent {
  assertHeadlessExecPolicy(bot, exec);

  const token = bot.tokenMint?.trim();
  if (!token) {
    throw new Error("TOKEN_MINT is required for Jupiter BUY/SELL legs.");
  }

  const rails = buildSafetyRailsFromBotEnv(bot);
  if (rails.maxInputRaw < exec.buySpendLamports) {
    throw new Error(
      `SOL_BOT_MAX_INPUT_RAW (${rails.maxInputRaw.toString()}) must be >= SIGNAL_EXEC_BUY_LAMPORTS (${exec.buySpendLamports.toString()}).`,
    );
  }
  if (rails.maxInputRaw < exec.sellTokenRaw) {
    throw new Error(
      `SOL_BOT_MAX_INPUT_RAW (${rails.maxInputRaw.toString()}) must be >= SIGNAL_EXEC_SELL_TOKEN_RAW (${exec.sellTokenRaw.toString()}) for the SELL leg cap check.`,
    );
  }

  const signer = createKeypairSigner(deps.keypair);
  const jupiter = createJupiterSignalExecutionAdapter({
    connection: deps.connection,
    userPublicKeyBase58: deps.keypair.publicKey.toBase58(),
    signTransaction: signer,
    rails,
    slippageBps: exec.slippageBps,
    targetMint: token,
    buySpendLamports: exec.buySpendLamports,
    sellTokenRaw: exec.sellTokenRaw,
    simulateOnly: exec.simulateOnly,
    ...(deps.onSwapComplete !== undefined ? { onSwapComplete: deps.onSwapComplete } : {}),
  });
  const execution = createDedupingExecutionAdapter(jupiter);

  return new SignalAgent({
    strategy: deps.strategy ?? DEFAULT_STRATEGY_CONFIG,
    ...(deps.computeIndicators !== undefined ? { computeIndicators: deps.computeIndicators } : {}),
    ...(deps.log !== undefined ? { log: deps.log } : {}),
    execution,
    executionHooksScope: "tail_bar_only",
    executionTailBarLookback: deps.executionTailBarLookback ?? 3,
  });
}

export function assertHeadlessExecPolicy(bot: BotEnv, exec: HeadlessSignalExecConfig): void {
  if (!exec.simulateOnly && bot.mode !== "live") {
    throw new Error("On-chain sends require MODE=live when SIGNAL_EXEC_SIMULATE_ONLY=0.");
  }
  if (bot.solBotKillSwitch) {
    throw new Error("SOL_BOT_KILL_SWITCH=1 blocks trading; clear it for this runner.");
  }
}
