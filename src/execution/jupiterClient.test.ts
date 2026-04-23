import { describe, expect, it } from "vitest";
import { buildJupiterQuoteUrl, fetchJupiterQuote, readMaxQuotedInputForPreflight, readQuotedInputAmount } from "./jupiterClient.js";

describe("readQuotedInputAmount", () => {
  it("parses string inAmount", () => {
    expect(readQuotedInputAmount({ inAmount: "12345" })).toBe(12345n);
  });

  it("parses numeric inAmount", () => {
    expect(readQuotedInputAmount({ inAmount: 99 })).toBe(99n);
  });

  it("rejects invalid shapes", () => {
    expect(() => readQuotedInputAmount({})).toThrow();
    expect(() => readQuotedInputAmount({ inAmount: "-1" })).toThrow();
  });
});

describe("readMaxQuotedInputForPreflight", () => {
  it("returns inAmount for ExactIn", () => {
    expect(readMaxQuotedInputForPreflight({ inAmount: "100" }, "ExactIn", 100)).toBe(100n);
  });

  it("returns inAmount for ExactOut when slippage is 0", () => {
    expect(readMaxQuotedInputForPreflight({ inAmount: "100" }, "ExactOut", 0)).toBe(100n);
  });

  it("ExactOut applies slippage ceiling to the input (Jupiter exact-out semantics)", () => {
    // 100 * 1.005 = 100.5 -> 101
    expect(readMaxQuotedInputForPreflight({ inAmount: "100" }, "ExactOut", 50)).toBe(101n);
  });
});

describe("buildJupiterQuoteUrl", () => {
  it("includes mints, amount, slippage, optional onlyDirectRoutes", () => {
    const u = buildJupiterQuoteUrl(
      {
        inputMint: "So11111111111111111111111111111111111111112",
        outputMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
        amount: 1_000_000n,
        slippageBps: 50,
        onlyDirectRoutes: true,
      },
      "https://api.jup.ag/swap/v1",
    );
    expect(u).toContain("inputMint=So11111111111111111111111111111111111111112");
    expect(u).toContain("onlyDirectRoutes=true");
    expect(u).toContain("amount=1000000");
  });

  it("includes swapMode=ExactOut when requested", () => {
    const u = buildJupiterQuoteUrl(
      {
        inputMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
        outputMint: "So11111111111111111111111111111111111111112",
        amount: 1_000_000n,
        slippageBps: 100,
        swapMode: "ExactOut",
      },
      "https://api.jup.ag/swap/v1",
    );
    expect(u).toContain("swapMode=ExactOut");
    expect(u).toContain("amount=1000000");
  });
});

describe("fetchJupiterQuote (mocked)", () => {
  it("throws on non-OK HTTP", async () => {
    const fetchFn = async () =>
      new Response("bad", {
        status: 500,
        statusText: "ERR",
      });
    await expect(
      fetchJupiterQuote(
        {
          inputMint: "So11111111111111111111111111111111111111112",
          outputMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
          amount: 1n,
          slippageBps: 50,
        },
        { fetchFn: fetchFn as typeof fetch },
      ),
    ).rejects.toThrow(/HTTP 500/);
  });

  it("returns JSON body on success", async () => {
    const body = { inAmount: "10", outAmount: "20" };
    const fetchFn = async () =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    const q = await fetchJupiterQuote(
      {
        inputMint: "So11111111111111111111111111111111111111112",
        outputMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
        amount: 1n,
        slippageBps: 50,
      },
      { fetchFn: fetchFn as typeof fetch },
    );
    expect(q).toEqual(body);
  });
});
