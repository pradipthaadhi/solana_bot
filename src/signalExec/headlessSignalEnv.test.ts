import { describe, expect, it } from "vitest";
import { DEFAULT_SIGNAL_EXEC_BUY_LAMPORTS, loadHeadlessSignalExecConfig } from "./headlessSignalEnv.js";

describe("loadHeadlessSignalExecConfig", () => {
  it("parses defaults (simulate-only on, 0.001 SOL buy default)", () => {
    const c = loadHeadlessSignalExecConfig({
      SIGNAL_EXEC_POOL_ADDRESS: "  SoMePoOl  ",
      SIGNAL_EXEC_SIMULATE_ONLY: "1",
    });
    expect(c.poolAddress).toBe("SoMePoOl");
    expect(c.simulateOnly).toBe(true);
    expect(c.buySpendLamports).toBe(DEFAULT_SIGNAL_EXEC_BUY_LAMPORTS);
    expect(c.sellTokenRaw).toBe(10_000n);
    expect(c.slippageBps).toBe(100);
    expect(c.pollMs).toBe(60_000);
  });

  it("throws without pool", () => {
    expect(() => loadHeadlessSignalExecConfig({})).toThrow(/SIGNAL_EXEC_POOL_ADDRESS/);
  });
});
