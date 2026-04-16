import type { Connection } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { assertRpcHealthy } from "./rpcHealth.js";

describe("assertRpcHealthy (Stage 5.5)", () => {
  it("resolves when getLatestBlockhash succeeds quickly", async () => {
    const conn = {
      getLatestBlockhash: async () => ({ blockhash: "x", lastValidBlockHeight: 1 }),
    } as unknown as Connection;
    await expect(assertRpcHealthy(conn, 2000)).resolves.toBeUndefined();
  });

  it("rejects on timeout", async () => {
    const conn = {
      getLatestBlockhash: () => new Promise(() => {}),
    } as unknown as Connection;
    await expect(assertRpcHealthy(conn, 30)).rejects.toThrow(/timed out/);
  });
});
