import { afterEach, describe, expect, it, vi } from "vitest";
import type { Ohlcv } from "../strategy/candleSemantics.js";
import {
  describeGeckoTerminalFetchError,
  fetchSolanaPoolOhlcv1m,
  geckoOhlcvListToBars,
  mergeTailRefresh,
  parseGeckoTerminalOhlcvJson,
  prependOlderOhlcv,
  resolveAltTokenMintForSolPool,
  WSOL_MINT,
} from "./geckoTerminalOhlcv.js";

function bar(timeSec: number, close: number): Ohlcv {
  const timeMs = timeSec * 1000;
  return { open: close, high: close, low: close, close, volume: 1, timeMs };
}

describe("describeGeckoTerminalFetchError", () => {
  it("maps proxy-like failures to actionable copy", () => {
    expect(describeGeckoTerminalFetchError(new Error("net::ERR_PROXY_CONNECTION_FAILED"))).toMatch(/proxy/i);
  });

  it("maps generic fetch failures to network guidance", () => {
    expect(describeGeckoTerminalFetchError(new TypeError("Failed to fetch"))).toMatch(/VPN|network dropped/i);
  });

  it("maps GeckoTerminal 404 pool-missing to user guidance", () => {
    expect(
      describeGeckoTerminalFetchError(
        new Error("GeckoTerminal: no OHLCV for this pool (HTTP 404)."),
      ),
    ).toMatch(/GeckoTerminal|demo/i);
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

  it("parses token addresses from meta and resolves alt mint for SOL pair", () => {
    const x = "Use1e55ssMINTxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";
    const json = {
      data: { attributes: { ohlcv_list: [[1_000, 1, 1, 1, 1, 1]] } },
      meta: {
        base: { symbol: "USELESS", address: x },
        quote: { symbol: "SOL", address: WSOL_MINT },
      },
    };
    const { meta } = parseGeckoTerminalOhlcvJson(json);
    expect(meta.baseTokenAddress).toBe(x);
    expect(meta.quoteTokenAddress).toBe(WSOL_MINT);
    expect(resolveAltTokenMintForSolPool(meta)).toBe(x);
    const inv = parseGeckoTerminalOhlcvJson({
      data: { attributes: { ohlcv_list: [[1_000, 1, 1, 1, 1, 1]] } },
      meta: {
        base: { symbol: "SOL", address: WSOL_MINT },
        quote: { symbol: "USELESS", address: x },
      },
    }).meta;
    expect(resolveAltTokenMintForSolPool(inv)).toBe(x);
    expect(
      resolveAltTokenMintForSolPool({
        baseTokenAddress: "TokenA",
        quoteTokenAddress: "TokenB",
      }),
    ).toBeNull();
  });
});

describe("mergeTailRefresh / prependOlderOhlcv", () => {
  it("mergeTailRefresh keeps prefix older than the new tail’s oldest bar", () => {
    const session = [bar(100, 1), bar(200, 2), bar(300, 3)];
    const tail = [bar(200, 22), bar(300, 33), bar(400, 4)];
    const m = mergeTailRefresh(session, tail);
    expect(m.map((b) => b.timeMs)).toEqual([100_000, 200_000, 300_000, 400_000]);
    expect(m.find((b) => b.timeMs === 200_000)?.close).toBe(22);
  });

  it("prependOlderOhlcv dedupes overlapping timestamps", () => {
    const session = [bar(200, 2)];
    const older = [bar(100, 1), bar(200, 9)];
    const m = prependOlderOhlcv(session, older);
    expect(m.map((b) => b.close)).toEqual([1, 2]);
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

  it("includes before_timestamp in the request URL when set", async () => {
    const spy = vi.fn(async () => new Response(JSON.stringify(emptyPayload), { status: 200 }));
    vi.stubGlobal("fetch", spy);
    await fetchSolanaPoolOhlcv1m({
      poolAddress: "PoolAddr1",
      limit: 10,
      beforeTimestampSec: 1_700_000_000,
      maxAttempts: 2,
      fetchTimeoutMs: 2000,
    });
    expect(spy).toHaveBeenCalled();
    const url = String(spy.mock.calls[0]?.[0] ?? "");
    expect(url).toContain("before_timestamp=1700000000");
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

  it("does not retry on HTTP 404 and throws a clear pool-missing error", async () => {
    let n = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        n += 1;
        return new Response(JSON.stringify({ errors: [{ status: "404", title: "Not Found" }] }), { status: 404 });
      }),
    );
    await expect(
      fetchSolanaPoolOhlcv1m({
        poolAddress: "UnknownPool",
        maxAttempts: 5,
        fetchTimeoutMs: 2000,
      }),
    ).rejects.toThrow(/GeckoTerminal: no OHLCV|HTTP 404/);
    expect(n).toBe(1);
  });
});
