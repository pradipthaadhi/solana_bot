import type { Connection } from "@solana/web3.js";

function rpcActionableHint(msg: string): string {
  const m = msg.toLowerCase();
  if (m.includes("timed out")) {
    return " Set VITE_RPC_URL to a private mainnet HTTPS RPC (see apps/chart-web/.env.example); public endpoints often hang from browsers under load.";
  }
  if (m.includes("403") || m.includes("forbidden")) {
    return " Public mainnet RPC often returns HTTP 403 from browsers (rate limits / abuse controls). Set VITE_RPC_URL in apps/chart-web/.env to a private HTTPS RPC (e.g. Alchemy Solana: https://www.alchemy.com/solana ).";
  }
  if (m.includes("429") || m.includes("too many requests")) {
    return " RPC rate-limited (429). Use a dedicated endpoint or retry later.";
  }
  if (m.includes("401") || m.includes("unauthorized")) {
    return " RPC rejected the request (401). Check API key / URL.";
  }
  return "";
}

/**
 * Stage 5.5 — lightweight RPC liveness check before swap/simulation/send.
 *
 * Uses `getSlot("processed")` instead of `getLatestBlockhash("confirmed")`: smaller response and less load
 * on congested public RPCs, so the check is less likely to hit false timeouts in the browser.
 */
export async function assertRpcHealthy(connection: Connection, timeoutMs = 20_000): Promise<void> {
  const timeout = new Promise<never>((_, reject) => {
    globalThis.setTimeout(() => reject(new Error(`RPC health check timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  try {
    await Promise.race([connection.getSlot("processed"), timeout]);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const hint = rpcActionableHint(msg);
    throw new Error(`RPC_UNHEALTHY: ${msg}${hint}`);
  }
}
