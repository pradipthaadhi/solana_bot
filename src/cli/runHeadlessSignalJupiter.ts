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
import type { ExecuteJupiterSwapResult } from "../execution/swapExecutor.js";
import { createSignalExecDashboard } from "./signalExecHttpDashboard.js";

function parseHttpDashboardPort(env: NodeJS.ProcessEnv): number | undefined {
  const raw = env.SIGNAL_EXEC_HTTP_PORT?.trim();
  if (raw === undefined || raw.length === 0) {
    return undefined;
  }
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1 || n > 65535 || !Number.isInteger(n)) {
    throw new Error("SIGNAL_EXEC_HTTP_PORT must be an integer 1–65535 when set.");
  }
  return n;
}

function logSwapResult(
  result: ExecuteJupiterSwapResult,
  leg: "entry" | "exit",
  execSimulateOnly: boolean,
  recordSwap?: (result: ExecuteJupiterSwapResult, leg: "entry" | "exit", simulateOnly: boolean) => void,
): void {
  const row: Record<string, unknown> = {
    kind: "SIGNAL_EXEC_SWAP",
    leg,
    hasSignature: Boolean(result.signature),
  };
  if (result.signature !== undefined) {
    row.signature = result.signature;
  }
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(row));
  recordSwap?.(result, leg, execSimulateOnly);
}

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
  const httpPort = parseHttpDashboardPort(process.env);

  const dash =
    httpPort !== undefined
      ? createSignalExecDashboard({
          walletPubkey: kp.publicKey.toBase58(),
          mode: bot.mode,
          simulateOnly: exec.simulateOnly,
          killSwitch: bot.solBotKillSwitch,
          poolAddress: exec.poolAddress,
          tokenMint: bot.tokenMint,
          pollMs: exec.pollMs,
        })
      : undefined;

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
    onSwapComplete: (result, leg) => logSwapResult(result, leg, exec.simulateOnly, dash?.recordSwap),
  });

  const httpSrv = dash !== undefined && httpPort !== undefined ? dash.startHttpServer(httpPort) : undefined;

  if (exec.runOnce) {
    const res = await agent.runTick(fetchBars);
    dash?.recordTick(res);
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(res, null, 2));
    httpSrv?.close();
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

  void agent
    .runTick(fetchBars)
    .then((res) => {
      dash?.recordTick(res);
    })
    .catch((err) => {
      // eslint-disable-next-line no-console
      console.error(err);
    });
  const handle = startSignalPolling(agent, fetchBars, exec.pollMs, {
    onTick: (res) => {
      dash?.recordTick(res);
    },
  });

  const shutdown = () => {
    handle.stop();
    httpSrv?.close();
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
