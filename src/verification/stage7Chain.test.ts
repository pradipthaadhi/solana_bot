/**
 * Stage 7.3 — optional live RPC checks (no swaps, no keys). Enable with `SOL_BOT_STAGE7_CHAIN_TEST=1`.
 */

import { Connection } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { assertRpcHealthy } from "../execution/rpcHealth.js";

const enabled = process.env.SOL_BOT_STAGE7_CHAIN_TEST === "1";

describe.skipIf(!enabled)("Stage 7.3 chain RPC (opt-in)", () => {
  it("devnet: RPC responds to getLatestBlockhash", async () => {
    const url = process.env.STAGE7_DEVNET_RPC_URL?.trim() || "https://api.devnet.solana.com";
    const c = new Connection(url, "confirmed");
    await assertRpcHealthy(c, 12_000);
    const bh = await c.getLatestBlockhash("confirmed");
    expect(bh.blockhash.length).toBeGreaterThan(10);
  }, 20_000);

  it.skipIf(!process.env.STAGE7_MAINNET_RPC_URL?.trim())(
    "mainnet-beta (read-only): RPC responds via STAGE7_MAINNET_RPC_URL",
    async () => {
      const url = process.env.STAGE7_MAINNET_RPC_URL!.trim();
      const c = new Connection(url, "confirmed");
      await assertRpcHealthy(c, 12_000);
      const bh = await c.getLatestBlockhash("confirmed");
      expect(bh.blockhash.length).toBeGreaterThan(10);
    },
    20_000,
  );
});
