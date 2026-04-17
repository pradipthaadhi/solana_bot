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
  /** GET attempts for transient network / 5xx / timeout failures. Default 5. */
  maxAttempts?: number;
  /** Per-attempt wall-clock timeout (ms). Default 45_000. */
  fetchTimeoutMs?: number;
}

const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_FETCH_TIMEOUT_MS = 45_000;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** Exponential backoff + small jitter so retries don't align on the same clock edge. */
async function backoffAfterAttempt(attempt: number): Promise<void> {
  const base = 400 * 2 ** attempt;
  const jitter = Math.floor(Math.random() * 280);
  await delay(base + jitter);
}

function isRetriableHttpStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || (status >= 500 && status <= 599);
}

function errorMessageOf(e: unknown): string {
  if (e instanceof Error) {
    return e.message;
  }
  if (typeof e === "string") {
    return e;
  }
  return String(e);
}

/**
 * Browser `fetch` often surfaces `ERR_NETWORK_CHANGED` / `ERR_PROXY_CONNECTION_FAILED`
 * as `TypeError: Failed to fetch` with no stable `code` field — match message heuristics too.
 */
function messageLooksTransientFetchFailure(msg: string): boolean {
  const m = msg.toLowerCase();
  return (
    m.includes("failed to fetch") ||
    m.includes("load failed") ||
    m.includes("networkerror") ||
    m.includes("network request failed") ||
    m.includes("network changed") ||
    m.includes("err_network") ||
    m.includes("proxy") ||
    m.includes("err_proxy") ||
    m.includes("econnreset") ||
    m.includes("etimedout") ||
    m.includes("eai_again") ||
    m.includes("enotfound") ||
    m.includes("econnrefused") ||
    (m.includes("connection") && m.includes("reset"))
  );
}

function isRetriableNetworkError(e: unknown): boolean {
  if (typeof DOMException !== "undefined" && e instanceof DOMException && e.name === "NetworkError") {
    return true;
  }
  if (e instanceof TypeError) {
    return true;
  }
  if (typeof AggregateError !== "undefined" && e instanceof AggregateError) {
    return e.errors.some((err) => isRetriableNetworkError(err));
  }
  const msg = errorMessageOf(e);
  if (msg.length > 0 && messageLooksTransientFetchFailure(msg)) {
    return true;
  }
  if (e instanceof Error && "code" in e) {
    const code = (e as NodeJS.ErrnoException).code;
    return code === "ETIMEDOUT" || code === "ECONNRESET" || code === "ECONNREFUSED" || code === "EAI_AGAIN";
  }
  return false;
}

/**
 * Human-oriented copy for UI when GeckoTerminal GET fails after retries.
 */
export function describeGeckoTerminalFetchError(e: unknown): string {
  const raw = errorMessageOf(e);
  const low = raw.toLowerCase();
  if (low.includes("proxy") || low.includes("err_proxy")) {
    return "Could not reach GeckoTerminal (browser proxy error). Try disabling VPN/system proxy for this tab, or allow HTTPS to api.geckoterminal.com.";
  }
  if (
    low.includes("failed to fetch") ||
    low.includes("network changed") ||
    low.includes("err_network") ||
    low.includes("load failed")
  ) {
    return "Network dropped while loading candles (common after Wi‑Fi/VPN changes). The app retries automatically; press Load if the chart stays empty.";
  }
  return raw.length > 0 ? raw : "Unknown error while fetching OHLCV.";
}

/**
 * Single GET with merged timeout + optional caller `signal` (caller abort wins; timeout retries unless caller aborted).
 */
async function fetchGeckoOhlcvOnce(
  url: string,
  externalSignal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<Response> {
  const merged = new AbortController();
  const timer = setTimeout(() => merged.abort(), timeoutMs);
  const onExternalAbort = (): void => {
    clearTimeout(timer);
    merged.abort();
  };
  if (externalSignal !== undefined) {
    if (externalSignal.aborted) {
      clearTimeout(timer);
      throw new DOMException("The operation was aborted.", "AbortError");
    }
    externalSignal.addEventListener("abort", onExternalAbort, { once: true });
  }
  try {
    return await fetch(url, {
      method: "GET",
      headers: { Accept: ACCEPT_VERSION },
      signal: merged.signal,
    });
  } finally {
    clearTimeout(timer);
    if (externalSignal !== undefined) {
      externalSignal.removeEventListener("abort", onExternalAbort);
    }
  }
}

export async function fetchSolanaPoolOhlcv1m(params: FetchSolanaPoolOhlcv1mParams): Promise<GeckoTerminalOhlcvResult> {
  const { poolAddress, limit = 500, signal: externalSignal } = params;
  const base = params.apiBaseUrl ?? "https://api.geckoterminal.com/api/v2";
  const maxAttempts = params.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const fetchTimeoutMs = params.fetchTimeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
  const url = new URL(`${base}/networks/solana/pools/${encodeURIComponent(poolAddress)}/ohlcv/minute`);
  url.searchParams.set("aggregate", "1");
  url.searchParams.set("limit", String(limit));
  const urlStr = url.toString();

  let lastError: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const res = await fetchGeckoOhlcvOnce(urlStr, externalSignal, fetchTimeoutMs);
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        if (isRetriableHttpStatus(res.status) && attempt < maxAttempts - 1) {
          await backoffAfterAttempt(attempt);
          continue;
        }
        throw new Error(`GeckoTerminal OHLCV failed: HTTP ${res.status} ${res.statusText} ${text.slice(0, 500)}`);
      }
      const json: unknown = await res.json();
      return parseGeckoTerminalOhlcvJson(json);
    } catch (e) {
      if (externalSignal?.aborted) {
        throw e;
      }
      lastError = e;
      const abortedByTimeout =
        e instanceof DOMException && e.name === "AbortError" && !externalSignal?.aborted;
      const retriable = abortedByTimeout || isRetriableNetworkError(e);
      if (retriable && attempt < maxAttempts - 1) {
        await backoffAfterAttempt(attempt);
        continue;
      }
      throw e;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}
