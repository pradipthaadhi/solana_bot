import { describe, expect, it } from "vitest";
import { fetchJupiterQuote, readQuotedInputAmount } from "./jupiterClient.js";

const LIVE = process.env.SOL_BOT_LIVE_JUPITER === "1";

describe.skipIf(!LIVE)("Jupiter live quote (optional SOL_BOT_LIVE_JUPITER=1)", () => {
  it("returns a routable quote for tiny SOL → USDC", async () => {
    const quote = await fetchJupiterQuote({
      inputMint: "So11111111111111111111111111111111111111112",
      outputMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      amount: 50_000n,
      slippageBps: 100,
      onlyDirectRoutes: false,
    });
    const inAmt = readQuotedInputAmount(quote);
    expect(inAmt).toBe(50_000n);
  });
});
