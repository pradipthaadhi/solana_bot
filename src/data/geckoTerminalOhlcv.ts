/**
 * GeckoTerminal 1-minute OHLCV for Solana pools (on-chain DEX data, ~1m cache).
 * @see https://api.geckoterminal.com/docs/index.html — GET /networks/{network}/pools/{pool}/ohlcv/{timeframe}
 */

import type { Ohlcv } from "../strategy/candleSemantics.js";

const ACCEPT_VERSION = "application/json;version=20230203";

export type GeckoTerminalPoolMeta = {
  baseSymbol?: string;
  quoteSymbol?: string;
};

export interface GeckoTerminalOhlcvResult {
  bars: Ohlcv[];
  meta: GeckoTerminalPoolMeta;
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null;
}

/**
 * Each row: `[timestamp_sec, open, high, low, close, volume]` (GeckoTerminal OHLCV list).
 * `timestamp_sec` is the **1m bucket open** time (UTC); we map `timeMs = timestamp_sec * 1000` for monotonic series + chart alignment.
 */
export function geckoOhlcvListToBars(rows: readonly unknown[]): Ohlcv[] {
  const out: Ohlcv[] = [];
  for (const row of rows) {
    if (!Array.isArray(row) || row.length < 6) {
      continue;
    }
    const [t, o, h, l, c, v] = row as unknown[];
    if (typeof t !== "number" || typeof o !== "number" || typeof h !== "number" || typeof l !== "number" || typeof c !== "number") {
      continue;
    }
    const vol = typeof v === "number" ? v : Number(v);
    if (!Number.isFinite(vol)) {
      continue;
    }
    const timeSec = t;
    const timeMs = timeSec * 1000;
    out.push({
      open: o,
      high: h,
      low: l,
      close: c,
      volume: vol,
      timeMs,
    });
  }
  out.sort((a, b) => a.timeMs - b.timeMs);
  return out;
}

function parseMeta(payload: unknown): GeckoTerminalPoolMeta {
  if (!isRecord(payload)) {
    return {};
  }
  const meta = payload.meta;
  if (!isRecord(meta)) {
    return {};
  }
  const base = meta.base;
  const quote = meta.quote;
  const baseSymbol = isRecord(base) && typeof base.symbol === "string" ? base.symbol : undefined;
  const quoteSymbol = isRecord(quote) && typeof quote.symbol === "string" ? quote.symbol : undefined;
  const out: GeckoTerminalPoolMeta = {};
  if (baseSymbol !== undefined) {
    out.baseSymbol = baseSymbol;
  }
  if (quoteSymbol !== undefined) {
    out.quoteSymbol = quoteSymbol;
  }
  return out;
}

export function parseGeckoTerminalOhlcvJson(payload: unknown): GeckoTerminalOhlcvResult {
  if (!isRecord(payload)) {
    return { bars: [], meta: {} };
  }
  const data = payload.data;
  if (!isRecord(data)) {
    return { bars: [], meta: parseMeta(payload) };
  }
  const attrs = data.attributes;
  if (!isRecord(attrs)) {
    return { bars: [], meta: parseMeta(payload) };
  }
  const list = attrs.ohlcv_list;
  if (!Array.isArray(list)) {
    return { bars: [], meta: parseMeta(payload) };
  }
  return { bars: geckoOhlcvListToBars(list), meta: parseMeta(payload) };
}

export interface FetchSolanaPoolOhlcv1mParams {
  poolAddress: string;
  /** 1 = 1-minute candles on GeckoTerminal. */
  aggregateMinutes?: 1;
  limit?: number;
  signal?: AbortSignal;
  /**
   * API root. Default public API. In local dev you may proxy e.g. `/gt-api` → `https://api.geckoterminal.com/api/v2`.
   */
  apiBaseUrl?: string;
}

export async function fetchSolanaPoolOhlcv1m(params: FetchSolanaPoolOhlcv1mParams): Promise<GeckoTerminalOhlcvResult> {
  const { poolAddress, limit = 500, signal } = params;
  const base = params.apiBaseUrl ?? "https://api.geckoterminal.com/api/v2";
  const url = new URL(`${base}/networks/solana/pools/${encodeURIComponent(poolAddress)}/ohlcv/minute`);
  url.searchParams.set("aggregate", "1");
  url.searchParams.set("limit", String(limit));
  const init: RequestInit = {
    method: "GET",
    headers: { Accept: ACCEPT_VERSION },
  };
  if (signal !== undefined) {
    init.signal = signal;
  }
  const res = await fetch(url.toString(), init);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`GeckoTerminal OHLCV failed: HTTP ${res.status} ${res.statusText} ${text.slice(0, 500)}`);
  }
  const json: unknown = await res.json();
  return parseGeckoTerminalOhlcvJson(json);
}
