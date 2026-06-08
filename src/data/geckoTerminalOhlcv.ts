/**
 * GeckoTerminal 1-minute OHLCV for Solana pools — public, IP-based, no API key required.
 * @see https://api.geckoterminal.com/docs/index.html
 *
 * Rate-limit design (public tier ≈ 10–30 req/min per IP across ALL agents on this IP):
 *  • DEFAULT_MAX_ATTEMPTS = 1 — fail fast; the caller (chart poll / headless runner) retries
 *    on the next natural poll cycle (~60 s) instead of hammering within the same tick.
 *  • HTTP 429 is NEVER retried — it throws {@link GeckoTerminalRateLimitError}, which carries the
 *    server's `Retry-After` (when present) so callers can size their cooldown precisely.
 *  • Keep the auto-polling instances per IP evenly staggered across the poll window so the
 *    combined request stream never bursts (the chart-web budget logic does this from the
 *    PM2 instance count — see apps/chart-web/src/main.ts).
 */

import type { Ohlcv } from "../strategy/candleSemantics.js";

const ACCEPT_VERSION = "application/json;version=20230203";

/** Wrapped SOL (same on mainnet; Jupiter uses this for native SOL in/out). */
export const WSOL_MINT = "So11111111111111111111111111111111111111112";

export type GeckoTerminalPoolMeta = {
  baseSymbol?: string;
  quoteSymbol?: string;
  /** Base token mint (Solana base58) when present in OHLCV meta. */
  baseTokenAddress?: string;
  /** Quote token mint (Solana base58) when present in OHLCV meta. */
  quoteTokenAddress?: string;
};

export interface GeckoTerminalOhlcvResult {
  bars: Ohlcv[];
  meta: GeckoTerminalPoolMeta;
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null;
}

/**
 * Each row: `[timestamp_sec, open, high, low, close, volume]`.
 * `timestamp_sec` is the 1-minute bucket **open** time (UTC); we store `timeMs = timestamp_sec * 1000`.
 */
export function geckoOhlcvListToBars(rows: readonly unknown[]): Ohlcv[] {
  const out: Ohlcv[] = [];
  for (const row of rows) {
    if (!Array.isArray(row) || row.length < 6) {
      continue;
    }
    const [t, o, h, l, c, v] = row as unknown[];
    if (
      typeof t !== "number" ||
      typeof o !== "number" ||
      typeof h !== "number" ||
      typeof l !== "number" ||
      typeof c !== "number"
    ) {
      continue;
    }
    const vol = typeof v === "number" ? v : Number(v);
    if (!Number.isFinite(vol)) {
      continue;
    }
    out.push({ open: o, high: h, low: l, close: c, volume: vol, timeMs: t * 1000 });
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
  const out: GeckoTerminalPoolMeta = {};
  if (isRecord(base)) {
    if (typeof base.symbol === "string") out.baseSymbol = base.symbol;
    if (typeof base.address === "string" && base.address.trim().length > 0) {
      out.baseTokenAddress = base.address.trim();
    }
  }
  if (isRecord(quote)) {
    if (typeof quote.symbol === "string") out.quoteSymbol = quote.symbol;
    if (typeof quote.address === "string" && quote.address.trim().length > 0) {
      out.quoteTokenAddress = quote.address.trim();
    }
  }
  return out;
}

/**
 * For a pool like TOKEN/SOL, GeckoTerminal marks one leg as {@link WSOL_MINT}.
 * Returns the **non-WSOL** mint for Jupiter routing, or `null` when ambiguous.
 */
export function resolveAltTokenMintForSolPool(m: GeckoTerminalPoolMeta): string | null {
  const b = m.baseTokenAddress?.trim() ?? "";
  const q = m.quoteTokenAddress?.trim() ?? "";
  if (b.length === 0 && q.length === 0) return null;
  const bIsWsol = b === WSOL_MINT;
  const qIsWsol = q === WSOL_MINT;
  if (bIsWsol && !qIsWsol && q.length > 0) return q;
  if (qIsWsol && !bIsWsol && b.length > 0) return b;
  return null;
}

export function parseGeckoTerminalOhlcvJson(payload: unknown): GeckoTerminalOhlcvResult {
  if (!isRecord(payload)) return { bars: [], meta: {} };
  const data = payload.data;
  if (!isRecord(data)) return { bars: [], meta: parseMeta(payload) };
  const attrs = data.attributes;
  if (!isRecord(attrs)) return { bars: [], meta: parseMeta(payload) };
  const list = attrs.ohlcv_list;
  if (!Array.isArray(list)) return { bars: [], meta: parseMeta(payload) };
  return { bars: geckoOhlcvListToBars(list), meta: parseMeta(payload) };
}

export function mergeOhlcvUniqueSorted(chunks: readonly (readonly Ohlcv[])[]): Ohlcv[] {
  const byTime = new Map<number, Ohlcv>();
  for (const chunk of chunks) {
    for (const b of chunk) {
      byTime.set(b.timeMs, b);
    }
  }
  return [...byTime.values()].sort((a, b) => a.timeMs - b.timeMs);
}

/**
 * Refresh the rolling tail while preserving bars older than the new tail's oldest bucket.
 */
export function mergeTailRefresh(session: readonly Ohlcv[], freshTail: readonly Ohlcv[]): Ohlcv[] {
  if (freshTail.length === 0) return [...session];
  const oldestFreshMs = freshTail[0]!.timeMs;
  const prefix = session.filter((b) => b.timeMs < oldestFreshMs);
  return mergeOhlcvUniqueSorted([prefix, freshTail]);
}

/** Prepend an older OHLCV page and de-duplicate by open time. */
export function prependOlderOhlcv(session: readonly Ohlcv[], olderChunk: readonly Ohlcv[]): Ohlcv[] {
  return mergeOhlcvUniqueSorted([olderChunk, session]);
}

export interface FetchSolanaPoolOhlcv1mParams {
  poolAddress: string;
  /** Fixed at 1-minute bars. */
  aggregateMinutes?: 1;
  /** Max rows (GeckoTerminal cap: 1000). Default 200. */
  limit?: number;
  /**
   * Unix **seconds** (bucket open). Returns candles strictly before this timestamp.
   * Used for loading older history pages.
   */
  beforeTimestampSec?: number;
  signal?: AbortSignal;
  /**
   * API root. Defaults to `https://api.geckoterminal.com/api/v2`.
   * In Vite dev, set to `${origin}/gt-api` so the Vite proxy handles the request.
   */
  apiBaseUrl?: string;
  /**
   * Maximum fetch attempts. **Default 1** — fail fast on the first error and let the
   * caller's next poll cycle retry, preventing rapid 429 bursts on a shared public IP.
   */
  maxAttempts?: number;
  /** Per-attempt wall-clock timeout (ms). Default 30_000. */
  fetchTimeoutMs?: number;
}

const DEFAULT_MAX_ATTEMPTS = 1;
const DEFAULT_FETCH_TIMEOUT_MS = 30_000;

/**
 * Thrown on HTTP 429 from GeckoTerminal. Carries the parsed `Retry-After` (ms) when the server
 * sent one, so the caller can pause for exactly as long as the API asks instead of guessing.
 * The message still contains "rate limited" / "429" so existing string checks keep working.
 */
export class GeckoTerminalRateLimitError extends Error {
  /** Milliseconds the server asked us to wait, parsed from `Retry-After`. Undefined when absent. */
  readonly retryAfterMs?: number;
  constructor(message: string, retryAfterMs?: number) {
    super(message);
    this.name = "GeckoTerminalRateLimitError";
    if (retryAfterMs !== undefined) {
      this.retryAfterMs = retryAfterMs;
    }
  }
}

/** `Retry-After` is either delta-seconds or an HTTP-date. Returns ms to wait, or undefined. */
export function parseRetryAfterMs(headerValue: string | null): number | undefined {
  if (headerValue === null) return undefined;
  const v = headerValue.trim();
  if (v.length === 0) return undefined;
  if (/^\d+$/.test(v)) {
    const secs = Number(v);
    return Number.isFinite(secs) ? Math.max(0, secs * 1000) : undefined;
  }
  const whenMs = Date.parse(v);
  if (Number.isFinite(whenMs)) {
    return Math.max(0, whenMs - Date.now());
  }
  return undefined;
}

/** Extract the server-requested cooldown (ms) from a thrown error, when it was a 429 with `Retry-After`. */
export function rateLimitRetryAfterMs(e: unknown): number | undefined {
  return e instanceof GeckoTerminalRateLimitError ? e.retryAfterMs : undefined;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function backoffAfterAttempt(attempt: number): Promise<void> {
  const base = 400 * 2 ** attempt;
  const jitter = Math.floor(Math.random() * 280);
  await delay(base + jitter);
}

/** 429 is never retriable — callers must apply their own cooldown window. */
function isRetriableHttpStatus(status: number): boolean {
  return status === 408 || status === 425 || (status >= 500 && status <= 599);
}

function errorMessageOf(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  return String(e);
}

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
  if (typeof DOMException !== "undefined" && e instanceof DOMException && e.name === "NetworkError") return true;
  if (e instanceof TypeError) return true;
  if (typeof AggregateError !== "undefined" && e instanceof AggregateError) {
    return e.errors.some((err) => isRetriableNetworkError(err));
  }
  const msg = errorMessageOf(e);
  if (msg.length > 0 && messageLooksTransientFetchFailure(msg)) return true;
  if (e instanceof Error && "code" in e) {
    const code = (e as NodeJS.ErrnoException).code;
    return code === "ETIMEDOUT" || code === "ECONNRESET" || code === "ECONNREFUSED" || code === "EAI_AGAIN";
  }
  return false;
}

/**
 * Human-readable banner copy for UI when a GeckoTerminal fetch fails.
 */
export function describeOhlcvFetchError(e: unknown): string {
  const raw = errorMessageOf(e);
  const low = raw.toLowerCase();
  if (low.includes("rate limited") || low.includes("429")) {
    return "GeckoTerminal rate limit hit (HTTP 429) — too many requests from this IP. The chart will retry automatically after a short cooldown. Reduce the number of running chart instances if this recurs.";
  }
  if (low.includes("geckoterminal: no ohlcv") || low.includes("not in geckoterminal") || (low.includes("404") && low.includes("gecko"))) {
    return "That pool has no 1m OHLCV on GeckoTerminal (HTTP 404). Use a valid Solana pool address from DexScreener → same pool on geckoterminal.com.";
  }
  if (low.includes("proxy") || low.includes("err_proxy")) {
    return "Could not reach GeckoTerminal (proxy error). Try disabling VPN/system proxy, or run: npm run chart:dev:direct-net";
  }
  if (low.includes("failed to fetch") || low.includes("network changed") || low.includes("err_network") || low.includes("load failed")) {
    return "Network dropped while loading candles. The chart retries automatically; press Load if it stays empty.";
  }
  return raw.length > 0 ? raw : "Unknown error while fetching OHLCV.";
}

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
  const { poolAddress, limit = 200, signal: externalSignal, beforeTimestampSec } = params;
  const base = (params.apiBaseUrl ?? "https://api.geckoterminal.com/api/v2").replace(/\/$/, "");
  const maxAttempts = params.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const fetchTimeoutMs = params.fetchTimeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
  const cappedLimit = Math.max(1, Math.min(limit, 1000));

  const url = new URL(`${base}/networks/solana/pools/${encodeURIComponent(poolAddress)}/ohlcv/minute`);
  url.searchParams.set("aggregate", "1");
  url.searchParams.set("limit", String(cappedLimit));
  if (beforeTimestampSec !== undefined) {
    url.searchParams.set("before_timestamp", String(Math.floor(beforeTimestampSec)));
  }
  const urlStr = url.toString();

  let lastError: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const res = await fetchGeckoOhlcvOnce(urlStr, externalSignal, fetchTimeoutMs);
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        if (res.status === 429) {
          const retryAfterMs = parseRetryAfterMs(res.headers.get("retry-after"));
          throw new GeckoTerminalRateLimitError(
            `GeckoTerminal rate limited (HTTP 429) — too many requests from this IP. ${text.slice(0, 200)}`,
            retryAfterMs,
          );
        }
        if (isRetriableHttpStatus(res.status) && attempt < maxAttempts - 1) {
          await backoffAfterAttempt(attempt);
          continue;
        }
        if (res.status === 404) {
          throw new Error(
            "GeckoTerminal: no OHLCV for this pool (HTTP 404). Use the full pool address from geckoterminal.com or DexScreener.",
          );
        }
        throw new Error(`GeckoTerminal OHLCV failed: HTTP ${res.status} ${res.statusText} ${text.slice(0, 400)}`);
      }
      const json: unknown = await res.json();
      return parseGeckoTerminalOhlcvJson(json);
    } catch (e) {
      if (externalSignal?.aborted) throw e;
      lastError = e;
      const msg = errorMessageOf(e);
      if (msg.includes("rate limited") || msg.includes("429")) throw e;
      const abortedByTimeout = e instanceof DOMException && e.name === "AbortError" && !externalSignal?.aborted;
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
