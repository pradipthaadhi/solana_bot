import { describe, expect, it } from "vitest";
import { assertBrowserExecPolicy, createBrowserJupiterSignalAgent } from "./browserJupiterSignalAgent.js";
import type { SafetyRails } from "../execution/types.js";

const rails: SafetyRails = {
  killSwitchEngaged: false,
  maxInputRaw: 10_000_000n,
  operationalMode: "paper",
};

describe("assertBrowserExecPolicy", () => {
  it("throws when kill switch engaged", () => {
    expect(() =>
      assertBrowserExecPolicy({ operationalMode: "live", simulateOnly: false, killSwitchEngaged: true }),
    ).toThrow(/kill switch/i);
  });

  it("throws when simulateOnly is false but mode is not live", () => {
    expect(() =>
      assertBrowserExecPolicy({ operationalMode: "paper", simulateOnly: false, killSwitchEngaged: false }),
    ).toThrow(/VITE_MODE=live/i);
  });

  it("allows paper + simulateOnly", () => {
    expect(() =>
      assertBrowserExecPolicy({ operationalMode: "paper", simulateOnly: true, killSwitchEngaged: false }),
    ).not.toThrow();
  });
});

describe("createBrowserJupiterSignalAgent", () => {
  it("throws when target mint is empty", () => {
    expect(() =>
      createBrowserJupiterSignalAgent({
        connection: {} as import("@solana/web3.js").Connection,
        userPublicKeyBase58: "11111111111111111111111111111111",
        signTransaction: async (tx) => tx,
        rails,
        slippageBps: 100,
        targetMint: "  ",
        buySpendLamports: 1_000n,
        sellTokenRaw: 1_000n,
        simulateOnly: true,
      }),
    ).toThrow(/targetMint/i);
  });

  it("throws when maxInputRaw is below buy spend", () => {
    expect(() =>
      createBrowserJupiterSignalAgent({
        connection: {} as import("@solana/web3.js").Connection,
        userPublicKeyBase58: "11111111111111111111111111111111",
        signTransaction: async (tx) => tx,
        rails: { ...rails, maxInputRaw: 100n },
        slippageBps: 100,
        targetMint: "So11111111111111111111111111111111111111112",
        buySpendLamports: 1_000_000n,
        sellTokenRaw: 1_000n,
        simulateOnly: true,
      }),
    ).toThrow(/maxInputRaw/i);
  });
});
