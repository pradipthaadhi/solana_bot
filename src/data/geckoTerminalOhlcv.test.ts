import { afterEach, describe, expect, it, vi } from "vitest";
import type { Ohlcv } from "../strategy/candleSemantics.js";
import {
  describeOhlcvFetchError,
  fetchSolanaPoolOhlcv1m,
  geckoOhlcvListToBars,
  mergeTailRefresh,
  parseGeckoTerminalOhlcvJson,
  prependOlderOhlcv,
  resolveAltTokenMintForSolPool,
  WSOL_MINT,
} from "./geckoTerminalOhlcv.js";

function bar(timeSec: number, close: number): Ohlcv {
  return { open: close, high: close, low: close, close, volume: 1, timeMs: timeSec * 1000 };
}

describe("describeOhlcvFetchError", () => {
  it("maps 429 / rate-limit errors to actionable copy", () => {
    expect(describeOhlcvFetchError(new Error("GeckoTerminal rate limited (HTTP 429)"))).toMatch(/429|rate.?limit/i);
  });

  it("maps proxy-like failures to actionable copy", () => {
    expect(describeOhlcvFetchError(new Error("net::ERR_PROXY_CONNECTION_FAILED"))).toMatch(/proxy/i);
  });

  it("maps generic fetch failures to network guidance", () => {
    expect(describeOhlcvFetchError(new TypeError("Failed to fetch"))).toMatch(/network|retry/i);
  });

  it("maps GeckoTerminal 404 pool-missing to user guidance", () => {
    expect(
      describeOhlcvFetchError(new Error("GeckoTerminal: no OHLCV for this pool (HTTP 404).")),
    ).toMatch(/404|GeckoTerminal/i);
  });
});

describe("geckoOhlcvListToBars", () => {
  it("parses rows and sorts ascending by open time", () => {
    const rows = [
      [200, 2, 2, 2, 2, 10],
      [100, 1, 1, 1, 1, 5],
    ];
    const bars = geckoOhlcvListToBars(rows);
    expect(bars.map((b) => b.timeMs)).toEqual([100_000, 200_000]);
    expect(bars[0]?.close).toBe(1);
    expect(bars[1]?.volume).toBe(10);
  });

  it("skips rows with missing or non-numeric OHLC values", () => {
    const rows = [
      [100, 1, 1, 1, 1, 5],
      [200, "bad", 1, 1, 1, 0],
      [300, 3, 3, 3, 3, 9],
    ];
    const bars = geckoOhlcvListToBars(rows);
    expect(bars).toHaveLength(2);
  });
});

describe("parseGeckoTerminalOhlcvJson", () => {
  it("parses full GeckoTerminal envelope", () => {
    const json = {
      data: { attributes: { ohlcv_list: [[1_000, 1, 2, 0.5, 1.5, 3]] } },
      meta: { base: { symbol: "AAA" }, quote: { symbol: "BBB" } },
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
  });

  it("returns empty bars for malformed input", () => {
    expect(parseGeckoTerminalOhlcvJson(null).bars).toHaveLength(0);
    expect(parseGeckoTerminalOhlcvJson({ data: {} }).bars).toHaveLength(0);
  });
});

describe("mergeTailRefresh / prependOlderOhlcv", () => {
  it("mergeTailRefresh keeps prefix older than the new tail", () => {
    const session = [bar(100, 1), bar(200, 2), bar(300, 3)];
    const tail = [bar(200, 22), bar(300, 33), bar(400, 4)];
    const m = mergeTailRefresh(session, tail);
    expect(m.map((b) => b.timeMs)).toEqual([100_000, 200_000, 300_000, 400_000]);
    expect(m.find((b) => b.timeMs === 200_000)?.close).toBe(22);
  });

  it("prependOlderOhlcv dedupes overlapping timestamps (session wins)", () => {
    const session = [bar(200, 2)];
    const older = [bar(100, 1), bar(200, 9)];
    const m = prependOlderOhlcv(session, older);
    expect(m.map((b) => b.close)).toEqual([1, 2]);
  });
});

describe("fetchSolanaPoolOhlcv1m — rate-limit contract", () => {
  const emptyPayload = {
    data: { attributes: { ohlcv_list: [] as unknown[] } },
    meta: {},
  };

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("succeeds on the first attempt (maxAttempts=1 default)", async () => {
    const spy = vi.fn(async () => new Response(JSON.stringify(emptyPayload), { status: 200 }));
    vi.stubGlobal("fetch", spy);
    const r = await fetchSolanaPoolOhlcv1m({ poolAddress: "PoolAddr1", fetchTimeoutMs: 2000 });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(r.bars).toEqual([]);
  });

  it("does NOT retry on HTTP 429 — throws immediately", async () => {
    let n = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        n += 1;
        return new Response("", { status: 429 });
      }),
    );
    await expect(
      fetchSolanaPoolOhlcv1m({ poolAddress: "PoolAddr1", maxAttempts: 5, fetchTimeoutMs: 2000 }),
    ).rejects.toThrow(/429|rate.?limit/i);
    expect(n).toBe(1);
  });

  it("does NOT retry on HTTP 404", async () => {
    let n = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        n += 1;
        return new Response("{}", { status: 404 });
      }),
    );
    await expect(
      fetchSolanaPoolOhlcv1m({ poolAddress: "UnknownPool", maxAttempts: 5, fetchTimeoutMs: 2000 }),
    ).rejects.toThrow(/404|GeckoTerminal/i);
    expect(n).toBe(1);
  });

  it("retries on transient network error when maxAttempts > 1", async () => {
    let n = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        n += 1;
        if (n < 2) throw new TypeError("Failed to fetch");
        return new Response(JSON.stringify(emptyPayload), { status: 200 });
      }),
    );
    const r = await fetchSolanaPoolOhlcv1m({
      poolAddress: "PoolAddr1",
      maxAttempts: 3,
      fetchTimeoutMs: 2000,
    });
    expect(n).toBe(2);
    expect(r.bars).toEqual([]);
  });

  it("includes before_timestamp in URL when set", async () => {
    const spy = vi.fn(async () => new Response(JSON.stringify(emptyPayload), { status: 200 }));
    vi.stubGlobal("fetch", spy);
    await fetchSolanaPoolOhlcv1m({
      poolAddress: "PoolAddr1",
      beforeTimestampSec: 1_700_000_000,
      fetchTimeoutMs: 2000,
    });
    expect(spy).toHaveBeenCalledWith(
      expect.stringContaining("before_timestamp=1700000000"),
      expect.anything(),
    );
  });

  it("does not call fetch when signal is already aborted", async () => {
    const ac = new AbortController();
    ac.abort();
    const spy = vi.fn();
    vi.stubGlobal("fetch", spy);
    await expect(
      fetchSolanaPoolOhlcv1m({ poolAddress: "PoolAddr1", signal: ac.signal }),
    ).rejects.toThrow();
    expect(spy).not.toHaveBeenCalled();
  });
});
