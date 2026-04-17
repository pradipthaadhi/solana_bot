import { afterEach, describe, expect, it, vi } from "vitest";
import {
  describeGeckoTerminalFetchError,
  fetchSolanaPoolOhlcv1m,
  geckoOhlcvListToBars,
  parseGeckoTerminalOhlcvJson,
} from "./geckoTerminalOhlcv.js";

describe("describeGeckoTerminalFetchError", () => {
  it("maps proxy-like failures to actionable copy", () => {
    expect(describeGeckoTerminalFetchError(new Error("net::ERR_PROXY_CONNECTION_FAILED"))).toMatch(/proxy/i);
  });

  it("maps generic fetch failures to network guidance", () => {
    expect(describeGeckoTerminalFetchError(new TypeError("Failed to fetch"))).toMatch(/VPN|network dropped/i);
  });
});

describe("geckoTerminalOhlcv", () => {
  it("parses ohlcv_list rows and sorts ascending by open time", () => {
    const rows = [
      [200, 2, 2, 2, 2, 10],
      [100, 1, 1, 1, 1, 5],
    ];
    const bars = geckoOhlcvListToBars(rows);
    expect(bars.map((b) => b.timeMs)).toEqual([100_000, 200_000]);
    expect(bars[0]?.close).toBe(1);
    expect(bars[1]?.volume).toBe(10);
  });

  it("parses full GeckoTerminal JSON envelope", () => {
    const json = {
      data: {
        attributes: {
          ohlcv_list: [[1_000, 1, 2, 0.5, 1.5, 3]],
        },
      },
      meta: {
        base: { symbol: "AAA" },
        quote: { symbol: "BBB" },
      },
    };
    const { bars, meta } = parseGeckoTerminalOhlcvJson(json);
    expect(bars).toHaveLength(1);
    expect(meta.baseSymbol).toBe("AAA");
    expect(meta.quoteSymbol).toBe("BBB");
  });
});

describe("fetchSolanaPoolOhlcv1m", () => {
  const emptyPayload = {
    data: { attributes: { ohlcv_list: [] as unknown[] } },
    meta: {},
  };

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("retries on Error with Failed to fetch message then succeeds", async () => {
    let n = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        n += 1;
        if (n < 2) {
          throw new Error("Failed to fetch");
        }
        return new Response(JSON.stringify(emptyPayload), { status: 200 });
      }),
    );
    const r = await fetchSolanaPoolOhlcv1m({
      poolAddress: "So11111111111111111111111111111111111111112",
      maxAttempts: 4,
      fetchTimeoutMs: 2000,
    });
    expect(n).toBe(2);
    expect(r.bars).toEqual([]);
  });

  it("retries on TypeError then succeeds", async () => {
    let n = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        n += 1;
        if (n < 2) {
          throw new TypeError("fetch failed");
        }
        return new Response(JSON.stringify(emptyPayload), { status: 200 });
      }),
    );
    const r = await fetchSolanaPoolOhlcv1m({
      poolAddress: "So11111111111111111111111111111111111111112",
      maxAttempts: 4,
      fetchTimeoutMs: 2000,
    });
    expect(n).toBe(2);
    expect(r.bars).toEqual([]);
  });

  it("does not retry when caller signal is already aborted", async () => {
    const ac = new AbortController();
    ac.abort();
    const spy = vi.fn();
    vi.stubGlobal("fetch", spy);
    await expect(
      fetchSolanaPoolOhlcv1m({
        poolAddress: "So11111111111111111111111111111111111111112",
        signal: ac.signal,
        maxAttempts: 3,
      }),
    ).rejects.toThrow();
    expect(spy).not.toHaveBeenCalled();
  });

  it("retries on HTTP 503 then succeeds", async () => {
    let n = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        n += 1;
        if (n < 3) {
          return new Response("unavailable", { status: 503 });
        }
        return new Response(JSON.stringify(emptyPayload), { status: 200 });
      }),
    );
    await fetchSolanaPoolOhlcv1m({
      poolAddress: "So11111111111111111111111111111111111111112",
      maxAttempts: 4,
      fetchTimeoutMs: 2000,
    });
    expect(n).toBe(3);
  });
});
