import type { Connection } from "@solana/web3.js";

/**
 * Stage 5.5 — lightweight RPC liveness check before quote/simulation/send.
 */
export async function assertRpcHealthy(connection: Connection, timeoutMs = 8_000): Promise<void> {
  const timeout = new Promise<never>((_, reject) => {
    globalThis.setTimeout(() => reject(new Error(`RPC health check timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  try {
    await Promise.race([connection.getLatestBlockhash("confirmed"), timeout]);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`RPC_UNHEALTHY: ${msg}`);
  }
}
