/**
 * Browser signal agent — same Jupiter + dedupe wiring as headless, but accepts any `SignVersionedTransaction`
 * (Phantom wallet or session keypair signer material).
 */

import type { Connection } from "@solana/web3.js";
import { SignalAgent, type ComputeIndicatorsFn, type SignalAgentParams } from "../agent/signalAgent.js";
import { createDedupingExecutionAdapter } from "../agent/executionAdapter.js";
import type { OperationalMode } from "../scope/stage0.js";
import { createJupiterSignalExecutionAdapter } from "../execution/jupiterExecutionAdapter.js";
import type { SafetyRails, SignVersionedTransaction } from "../execution/types.js";
import type { Ohlcv } from "../strategy/candleSemantics.js";
import { DEFAULT_STRATEGY_CONFIG, type StrategyConfig } from "../strategy/strategyConfig.js";

export interface BrowserJupiterSignalAgentConfig {
  connection: Connection;
  userPublicKeyBase58: string;
  signTransaction: SignVersionedTransaction;
  rails: SafetyRails;
  slippageBps: number;
  targetMint: string;
  buySpendLamports: bigint;
  sellTokenRaw: bigint;
  simulateOnly: boolean;
}

export interface BrowserJupiterAgentDeps {
  strategy?: StrategyConfig;
  computeIndicators?: ComputeIndicatorsFn;
  executionTailBarLookback?: number;
  log?: SignalAgentParams["log"];
}

export function assertBrowserExecPolicy(p: {
  operationalMode: OperationalMode;
  simulateOnly: boolean;
  killSwitchEngaged: boolean;
}): void {
  if (p.killSwitchEngaged) {
    throw new Error("Kill switch is engaged; refusing to build a swap-enabled signal agent.");
  }
  if (!p.simulateOnly && p.operationalMode !== "live") {
    throw new Error("On-chain sends require VITE_MODE=live when Simulate only is unchecked.");
  }
}

/**
 * Build a {@link SignalAgent} that runs Jupiter swaps on tail `SIGNAL_ENTRY` / `SIGNAL_EXIT` hooks.
 */
export function createBrowserJupiterSignalAgent(
  cfg: BrowserJupiterSignalAgentConfig,
  deps: BrowserJupiterAgentDeps = {},
): SignalAgent {
  const token = cfg.targetMint.trim();
  if (!token) {
    throw new Error("targetMint is required for Jupiter BUY/SELL legs.");
  }

  if (cfg.rails.maxInputRaw < cfg.buySpendLamports) {
    throw new Error(
      `maxInputRaw (${cfg.rails.maxInputRaw.toString()}) must be >= buySpendLamports (${cfg.buySpendLamports.toString()}).`,
    );
  }
  if (cfg.rails.maxInputRaw < cfg.sellTokenRaw) {
    throw new Error(
      `maxInputRaw (${cfg.rails.maxInputRaw.toString()}) must be >= sellTokenRaw (${cfg.sellTokenRaw.toString()}).`,
    );
  }

  const jupiter = createJupiterSignalExecutionAdapter({
    connection: cfg.connection,
    userPublicKeyBase58: cfg.userPublicKeyBase58,
    signTransaction: cfg.signTransaction,
    rails: cfg.rails,
    slippageBps: cfg.slippageBps,
    targetMint: token,
    buySpendLamports: cfg.buySpendLamports,
    sellTokenRaw: cfg.sellTokenRaw,
    simulateOnly: cfg.simulateOnly,
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
