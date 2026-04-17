/**
 * Headless signal → Jupiter runner (Node only). Chart-web remains notify-only.
 *
 * @see docs/RUNBOOK_SIGNAL_EXEC.md
 */

import process from "node:process";
import { Connection } from "@solana/web3.js";
import { startSignalPolling } from "../agent/signalAgent.js";
import { loadBotEnv } from "../config/botEnv.js";
import { fetchSolanaPoolOhlcv1m } from "../data/geckoTerminalOhlcv.js";
import { loadDevKeypairFromEnv } from "../execution/devKeypair.js";
import { loadHeadlessSignalExecConfig } from "../signalExec/headlessSignalEnv.js";
import { createHeadlessJupiterSignalAgent } from "../signalExec/wireHeadlessJupiterSignalAgent.js";

async function main(): Promise<void> {
  if (process.env.SIGNAL_EXEC_ENABLED !== "1") {
    // eslint-disable-next-line no-console
    console.error("Refusing to start: set SIGNAL_EXEC_ENABLED=1 (see docs/RUNBOOK_SIGNAL_EXEC.md).");
    process.exit(1);
  }

  const bot = loadBotEnv(process.env);
  const exec = loadHeadlessSignalExecConfig(process.env);
  const kp = loadDevKeypairFromEnv(process.env);
  const connection = new Connection(bot.rpcUrl, "confirmed");

  const fetchBars = async () => {
    const { bars } = await fetchSolanaPoolOhlcv1m({
      poolAddress: exec.poolAddress,
      limit: 1000,
      ...(exec.geckoApiBaseUrl !== undefined ? { apiBaseUrl: exec.geckoApiBaseUrl } : {}),
    });
    return bars;
  };

  const agent = createHeadlessJupiterSignalAgent(bot, exec, {
    connection,
    keypair: kp,
    fetchBars,
  });

  if (exec.runOnce) {
    const res = await agent.runTick(fetchBars);
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(res, null, 2));
    process.exit(res.ok ? 0 : 1);
  }

  // eslint-disable-next-line no-console
  console.log(
    JSON.stringify({
      kind: "HEADLESS_SIGNAL_JUPITER_START",
      pool: exec.poolAddress,
      pollMs: exec.pollMs,
      simulateOnly: exec.simulateOnly,
      mode: bot.mode,
    }),
  );

  void agent.runTick(fetchBars).catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err);
  });
  const handle = startSignalPolling(agent, fetchBars, exec.pollMs);

  const shutdown = () => {
    handle.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

void main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
