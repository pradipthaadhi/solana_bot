/**
 * Vite dev / preview middleware: POST `/api/suggest-gecko-pool` → ranked pools (DexScreener, GeckoTerminal), then Perplexity fallback.
 * `PERPLEXITY_API_KEY` is optional when DexScreener or GeckoTerminal returns pairs.
 */

import https from "node:https";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Plugin } from "vite";

const upstreamAgent = new https.Agent({ family: 4, keepAlive: true });

/** Wrapped SOL mint — preferred quote side for “main chart” liquidity on DexScreener pairs. */
export const WSOL_MINT_MAINNET = "So11111111111111111111111111111111111111112";

/** Max pools returned by `/api/suggest-gecko-pool` (DexScreener / Gecko ranking). */
export const MAX_SUGGESTED_POOLS = 5 as const;

export type SuggestedPoolRow = {
  rank: number;
  poolAddress: string;
  pairHint: string;
  notes: string;
};

const PERPLEXITY_HOST = "api.perplexity.ai";
/** Perplexity Sonar chat completions — canonical path (OpenAI SDK alias is `/chat/completions`, not `/v1/chat/completions`). */
const PERPLEXITY_CHAT_PATH = "/v1/sonar";

/** Default minimum wall-clock time from POST to Perplexity until we respond (pads fast upstream replies). Sonar does not expose “search for N seconds”; this guarantees budget for retrieval + generation. */
export const DEFAULT_MIN_PERPLEXITY_ROUNDTRIP_MS = 5000;

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function enforceMinimumElapsed(startedAtMs: number, minElapsedMs: number): Promise<void> {
  if (minElapsedMs <= 0) {
    return;
  }
  const elapsed = Date.now() - startedAtMs;
  const pad = minElapsedMs - elapsed;
  if (pad > 0) {
    await sleepMs(pad);
  }
}

export function looksLikeSolanaAddressBase58(s: string): boolean {
  const t = s.trim();
  if (t.length < 32 || t.length > 48) {
    return false;
  }
  return /^[1-9A-HJ-NP-Za-km-z]+$/.test(t);
}

export function buildGeckoPoolSuggestPrompt(tokenMint: string): string {
  return [
    `Solana SPL mint (base58): ${tokenMint}

Primary sources (open these; pair/pool addresses appear explicitly as base58, distinct from the mint):
- DexScreener token page: https://dexscreener.com/solana/${tokenMint}
- DexScreener pairs JSON: https://api.dexscreener.com/latest/dex/tokens/${tokenMint}
- GeckoTerminal token API: https://api.geckoterminal.com/api/v2/networks/solana/tokens/${tokenMint}

Tasks:
1. Prefer the SOL-quoted pair with highest 24h USD volume (or liquidity). pairAddress from DexScreener is the GeckoTerminal-style Solana pool id for charts.
2. Never return the token mint as poolAddress — only the pair/pool account base58 from those sources.
3. If sources disagree, prefer DexScreener pairAddress for the top SOL pool.`,
    `Respond with a single JSON object only (schema keys poolAddress, pairHint, notes — use empty strings only when no verified pool).`,
  ].join("\n\n");
}

/** Parsed model reply: usable pool id, honest empty pool, or not JSON / unusable shape. */
export type GeckoPoolAssistantOutcome =
  | { outcome: "pool"; poolAddress: string; pairHint?: string; notes?: string }
  | { outcome: "no_pool"; pairHint?: string; notes?: string }
  | { outcome: "unparsed" };

const POOL_ADDRESS_JSON_KEYS = [
  "poolAddress",
  "primaryPoolAddress",
  "pool_address",
  "ammId",
  "amm_id",
  "pairAddress",
  "pair_address",
  "pool",
  "liquidity_pool_address",
] as const;

/** First plausible Solana pubkey in text that is not the excluded mint (typically token mint). */
export function extractFirstDistinctSolanaPubkey(text: string, excludeMint?: string): string | null {
  const ex = excludeMint?.trim();
  const re = /[1-9A-HJ-NP-Za-km-z]{32,48}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const s = m[0];
    if (!looksLikeSolanaAddressBase58(s)) {
      continue;
    }
    if (ex !== undefined && ex.length > 0 && s === ex) {
      continue;
    }
    return s;
  }
  return null;
}

function readOptionalString(o: Record<string, unknown>, key: string): string | undefined {
  const v = o[key];
  return typeof v === "string" ? v.trim() : undefined;
}

function normalizePoolAddressFromRecord(o: Record<string, unknown>): string {
  for (const k of POOL_ADDRESS_JSON_KEYS) {
    const v = readOptionalString(o, k);
    if (v !== undefined && v.length > 0) {
      return v;
    }
  }
  return "";
}

export function classifyGeckoPoolAssistantJson(raw: string, mint?: string): GeckoPoolAssistantOutcome {
  const mintNorm = mint?.trim();
  const t = raw.trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  let candidate = (fence ? fence[1] : t)?.trim() ?? "";
  const brace = candidate.indexOf("{");
  if (brace > 0) {
    candidate = candidate.slice(brace);
  }

  let o: Record<string, unknown>;
  try {
    o = JSON.parse(candidate) as Record<string, unknown>;
  } catch {
    const hit = extractFirstDistinctSolanaPubkey(t, mintNorm);
    if (hit !== null) {
      return {
        outcome: "pool",
        poolAddress: hit,
        notes: "Parsed from non-JSON model text (fallback). Verify on GeckoTerminal.",
      };
    }
    return { outcome: "unparsed" };
  }

  const addrRaw = normalizePoolAddressFromRecord(o);
  let pairHint = readOptionalString(o, "pairHint") ?? readOptionalString(o, "pair") ?? readOptionalString(o, "dexPlatform");
  let notes =
    readOptionalString(o, "notes") ??
    readOptionalString(o, "reason") ??
    readOptionalString(o, "explanation");

  if (looksLikeSolanaAddressBase58(addrRaw) && (!mintNorm || addrRaw !== mintNorm)) {
    return { outcome: "pool", poolAddress: addrRaw, pairHint, notes };
  }

  const blob = JSON.stringify(o);
  const scanned = extractFirstDistinctSolanaPubkey(blob, mintNorm);
  if (scanned !== null) {
    return {
      outcome: "pool",
      poolAddress: scanned,
      pairHint,
      notes: notes ?? "Extracted address from model JSON values (fallback).",
    };
  }

  const proseHit =
    extractFirstDistinctSolanaPubkey(notes ?? "", mintNorm) ??
    extractFirstDistinctSolanaPubkey(pairHint ?? "", mintNorm);
  if (proseHit !== null) {
    return {
      outcome: "pool",
      poolAddress: proseHit,
      pairHint,
      notes: notes ?? "Extracted address from notes/pairHint text.",
    };
  }

  return { outcome: "no_pool", pairHint, notes };
}

/** Non-null only when JSON parses and `poolAddress` passes Solana base58 shape checks. */
export function parseGeckoPoolJsonFromAssistant(raw: string, mint?: string): {
  poolAddress: string;
  pairHint?: string;
  notes?: string;
} | null {
  const c = classifyGeckoPoolAssistantJson(raw, mint);
  return c.outcome === "pool" ? { poolAddress: c.poolAddress, pairHint: c.pairHint, notes: c.notes } : null;
}

type DexScreenerPairRow = {
  chainId?: string;
  dexId?: string;
  pairAddress?: string;
  baseToken?: { address?: string; symbol?: string };
  quoteToken?: { address?: string; symbol?: string };
  volume?: { h24?: number };
  liquidity?: { usd?: number };
};

export type DexScreenerPoolPick = {
  poolAddress: string;
  pairHint: string;
  notes: string;
};

export function suggestedRowsFromDexPicks(picks: readonly DexScreenerPoolPick[]): SuggestedPoolRow[] {
  return picks.slice(0, MAX_SUGGESTED_POOLS).map((p, i) => ({
    rank: i + 1,
    poolAddress: p.poolAddress,
    pairHint: p.pairHint,
    notes: p.notes,
  }));
}

function dexRowScore(p: DexScreenerPairRow): number {
  const v = typeof p.volume?.h24 === "number" && Number.isFinite(p.volume.h24) ? p.volume.h24 : 0;
  const l = typeof p.liquidity?.usd === "number" && Number.isFinite(p.liquidity.usd) ? p.liquidity.usd : 0;
  return v * 1_000_000 + l;
}

/** DexScreener rows involving `mint`, ranked by h24 volume then liquidity (SOL-linked pairs preferred). */
export function rankDexScreenerSolanaPairsForMint(
  pairs: readonly DexScreenerPairRow[],
  mint: string,
  limit: number = MAX_SUGGESTED_POOLS,
): DexScreenerPairRow[] {
  const m = mint.trim();
  const wsol = WSOL_MINT_MAINNET;
  const rows = pairs.filter(
    (p) =>
      p.chainId === "solana" &&
      typeof p.pairAddress === "string" &&
      looksLikeSolanaAddressBase58(p.pairAddress.trim()) &&
      p.pairAddress.trim() !== m,
  );
  const involving = rows.filter((p) => p.baseToken?.address === m || p.quoteToken?.address === m);
  const candidates = involving.length > 0 ? involving : rows;
  if (candidates.length === 0) {
    return [];
  }

  const solLinked = candidates.filter((p) => p.baseToken?.address === wsol || p.quoteToken?.address === wsol);
  const bucket = solLinked.length > 0 ? solLinked : candidates;
  bucket.sort((a, b) => dexRowScore(b) - dexRowScore(a));

  const cap = Math.max(1, Math.min(limit, MAX_SUGGESTED_POOLS));
  const out: DexScreenerPairRow[] = [];
  const seen = new Set<string>();
  for (const p of bucket) {
    const addr = p.pairAddress?.trim() ?? "";
    if (!looksLikeSolanaAddressBase58(addr) || addr === m || seen.has(addr)) {
      continue;
    }
    seen.add(addr);
    out.push(p);
    if (out.length >= cap) {
      break;
    }
  }
  return out;
}

export function dexScreenerRowToPick(p: DexScreenerPairRow, mint: string): DexScreenerPoolPick | null {
  const m = mint.trim();
  const addr = p.pairAddress?.trim() ?? "";
  if (!looksLikeSolanaAddressBase58(addr) || addr === m) {
    return null;
  }
  const tokenLeg = p.baseToken?.address === m ? p.baseToken : p.quoteToken?.address === m ? p.quoteToken : p.baseToken;
  const otherLeg = p.baseToken?.address === m ? p.quoteToken : p.quoteToken?.address === m ? p.baseToken : p.quoteToken;
  const symTok = tokenLeg?.symbol?.trim() || "?";
  const symOth = otherLeg?.symbol?.trim() || "?";
  const pairHint = `${symTok}/${symOth}`;
  const dexId = typeof p.dexId === "string" ? p.dexId : "unknown-dex";
  const liq = p.liquidity?.usd;
  const vol = p.volume?.h24;
  const liqPart = typeof liq === "number" && Number.isFinite(liq) ? `~$${Math.round(liq)} liq` : "liq n/a";
  const volPart = typeof vol === "number" && Number.isFinite(vol) ? `h24 vol ~$${Math.round(vol)}` : "h24 vol n/a";
  return {
    poolAddress: addr,
    pairHint,
    notes: `DexScreener · ${dexId} · ${liqPart} · ${volPart} — verify on GeckoTerminal.`,
  };
}

/** Prefer SOL-quoted pairs by h24 USD volume, then liquidity (DexScreener `/latest/dex/tokens` rows). */
export function pickBestDexScreenerSolanaPair(pairs: readonly DexScreenerPairRow[], mint: string): DexScreenerPoolPick | null {
  const rows = rankDexScreenerSolanaPairsForMint(pairs, mint, 1);
  const top = rows[0];
  return top !== undefined ? dexScreenerRowToPick(top, mint.trim()) : null;
}

/** Up to `limit` ranked distinct pair picks for API responses. */
export function pickRankedDexScreenerSolanaPairs(
  pairs: readonly DexScreenerPairRow[],
  mint: string,
  limit: number = MAX_SUGGESTED_POOLS,
): DexScreenerPoolPick[] {
  const ranked = rankDexScreenerSolanaPairsForMint(pairs, mint, limit);
  const out: DexScreenerPoolPick[] = [];
  for (const row of ranked) {
    const pick = dexScreenerRowToPick(row, mint.trim());
    if (pick !== null) {
      out.push(pick);
    }
  }
  return out;
}

function httpsRequestSimple(opts: {
  hostname: string;
  path: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
}): Promise<{ status: number; body: string }> {
  const payload = opts.body;
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: opts.hostname,
        port: 443,
        path: opts.path,
        method: opts.method ?? "GET",
        agent: upstreamAgent,
        headers: {
          Accept: "application/json",
          "User-Agent": "sol-bot-chart-web/1.0",
          ...(payload !== undefined ? { "Content-Length": Buffer.byteLength(payload) } : {}),
          ...opts.headers,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          resolve({
            status: res.statusCode ?? 502,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
      },
    );
    const t = opts.timeoutMs ?? 14_000;
    req.setTimeout(t, () => {
      req.destroy(new Error(`HTTPS timeout (${t}ms)`));
    });
    req.on("error", reject);
    if (payload !== undefined) {
      req.write(payload);
    }
    req.end();
  });
}

/** DexScreener public token endpoint — strongest deterministic mint → pair mapping for Solana. */
export async function fetchDexScreenerRankedPools(
  mint: string,
  limit: number = MAX_SUGGESTED_POOLS,
): Promise<DexScreenerPoolPick[]> {
  try {
    const path = `/latest/dex/tokens/${encodeURIComponent(mint.trim())}`;
    const { status, body } = await httpsRequestSimple({
      hostname: "api.dexscreener.com",
      path,
      timeoutMs: 14_000,
    });
    if (status < 200 || status >= 300) {
      return [];
    }
    const j = JSON.parse(body) as { pairs?: DexScreenerPairRow[] };
    return pickRankedDexScreenerSolanaPairs(j.pairs ?? [], mint.trim(), limit);
  } catch {
    return [];
  }
}

export async function fetchDexScreenerPrimaryPool(mint: string): Promise<DexScreenerPoolPick | null> {
  const list = await fetchDexScreenerRankedPools(mint, 1);
  return list[0] ?? null;
}

/** GeckoTerminal token detail includes ordered top pools (`solana_<poolAddress>` ids). */
export async function fetchGeckoTerminalRankedPools(
  mint: string,
  limit: number = MAX_SUGGESTED_POOLS,
): Promise<DexScreenerPoolPick[]> {
  try {
    const path = `/api/v2/networks/solana/tokens/${encodeURIComponent(mint.trim())}`;
    const { status, body } = await httpsRequestSimple({
      hostname: "api.geckoterminal.com",
      path,
      timeoutMs: 14_000,
    });
    if (status < 200 || status >= 300) {
      return [];
    }
    const j = JSON.parse(body) as {
      data?: {
        relationships?: {
          top_pools?: { data?: ReadonlyArray<{ id?: string }> };
        };
      };
    };
    const list = j.data?.relationships?.top_pools?.data ?? [];
    const m = mint.trim();
    const cap = Math.max(1, Math.min(limit, MAX_SUGGESTED_POOLS));
    const out: DexScreenerPoolPick[] = [];
    const seen = new Set<string>();
    let idx = 0;
    for (const item of list) {
      const rawId = item.id;
      if (typeof rawId !== "string" || rawId.length === 0) {
        continue;
      }
      const poolAddress = rawId.startsWith("solana_") ? rawId.slice("solana_".length) : rawId;
      if (!looksLikeSolanaAddressBase58(poolAddress) || poolAddress === m || seen.has(poolAddress)) {
        continue;
      }
      seen.add(poolAddress);
      idx += 1;
      out.push({
        poolAddress,
        pairHint: "",
        notes: `GeckoTerminal API — top pool #${idx} for this mint; confirm on-site.`,
      });
      if (out.length >= cap) {
        break;
      }
    }
    return out;
  } catch {
    return [];
  }
}

export async function fetchGeckoTerminalTopPoolAddress(mint: string): Promise<{ poolAddress: string; notes: string } | null> {
  const picks = await fetchGeckoTerminalRankedPools(mint, 1);
  const first = picks[0];
  return first !== undefined ? { poolAddress: first.poolAddress, notes: first.notes } : null;
}

/** JSON Schema for Perplexity structured outputs on `/v1/sonar`. */
export function geckoPoolSuggestionResponseFormat(): {
  type: "json_schema";
  json_schema: { name: string; strict: boolean; schema: Record<string, unknown> };
} {
  return {
    type: "json_schema",
    json_schema: {
      name: "gecko_pool_suggestion",
      strict: true,
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          poolAddress: {
            type: "string",
            description:
              "Solana pair/pool account used by GeckoTerminal charts (DexScreener pairAddress). Empty string only if unknown.",
          },
          pairHint: {
            type: "string",
            description: 'Human-readable pair, e.g. "TOKEN/SOL". Empty string if unknown.',
          },
          notes: {
            type: "string",
            description: "Short citation: Dex name, liquidity/volume, URL. Empty string if none.",
          },
        },
        required: ["poolAddress", "pairHint", "notes"],
      },
    },
  };
}

/** POST JSON body `{ mint: string }` → `{ ok, pools?, poolAddress?, … }` — `pools` has up to `MAX_SUGGESTED_POOLS` ranked rows when `ok`. */
export function perplexitySuggestPoolPlugin(
  apiKey: string,
  model: string,
  minRoundtripMs: number = DEFAULT_MIN_PERPLEXITY_ROUNDTRIP_MS,
): Plugin {
  const key = apiKey.trim();
  const mdl = model.trim() || "sonar-pro";
  const minMs = Number.isFinite(minRoundtripMs) && minRoundtripMs >= 0 ? Math.min(minRoundtripMs, 120_000) : DEFAULT_MIN_PERPLEXITY_ROUNDTRIP_MS;

  async function forwardToPerplexity(userContent: string): Promise<{ status: number; body: string }> {
    /**
     * Web UI answers often feel stronger because the site runs broader retrieval by default.
     * Sonar API defaults lean cheaper (`search_context_size`: low); combined with a strict JSON-only
     * prompt, the search classifier can also skip retrieval if we don't disable it explicitly.
     * @see https://docs.perplexity.ai/docs/sonar/features — prefer API search params over prompt hacks.
     * @see https://docs.perplexity.ai/docs/sonar/filters — search_context_size, disable_search, enable_search_classifier
     */
    const payload = JSON.stringify({
      model: mdl,
      temperature: 0.15,
      max_tokens: 1024,
      disable_search: false,
      enable_search_classifier: false,
      response_format: geckoPoolSuggestionResponseFormat(),
      web_search_options: {
        search_context_size: "high",
        search_type: "pro",
      },
      messages: [
        {
          role: "system",
          content:
            "You research Solana liquidity pools using Perplexity web search. Never invent pubkeys.\n\n" +
            "Always output a single JSON object only (no markdown fences, no commentary). Required keys: poolAddress (GeckoTerminal/DexScreener pair base58, or empty string if unknown), pairHint (e.g. TOKEN/SOL, or empty string), notes (short citation or empty string).",
        },
        { role: "user", content: userContent },
      ],
    });

    return await new Promise((resolve, reject) => {
      const req = https.request(
        {
          hostname: PERPLEXITY_HOST,
          port: 443,
          path: PERPLEXITY_CHAT_PATH,
          method: "POST",
          agent: upstreamAgent,
          headers: {
            Authorization: `Bearer ${key}`,
            "Content-Type": "application/json",
            Accept: "application/json",
            "Content-Length": Buffer.byteLength(payload),
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("end", () => {
            resolve({
              status: res.statusCode ?? 502,
              body: Buffer.concat(chunks).toString("utf8"),
            });
          });
        },
      );
      req.on("error", reject);
      req.write(payload);
      req.end();
    });
  }

  function extractAssistantText(perplexityJson: string): string | null {
    try {
      const o = JSON.parse(perplexityJson) as {
        choices?: ReadonlyArray<{ message?: { content?: unknown } }>;
      };
      const c = o.choices?.[0]?.message?.content;
      if (typeof c === "string") {
        return c;
      }
      if (Array.isArray(c)) {
        const parts: string[] = [];
        for (const chunk of c) {
          if (
            chunk !== null &&
            typeof chunk === "object" &&
            "type" in chunk &&
            chunk.type === "text" &&
            "text" in chunk &&
            typeof (chunk as { text?: unknown }).text === "string"
          ) {
            parts.push((chunk as { text: string }).text);
          }
        }
        const joined = parts.join("");
        return joined.length > 0 ? joined : null;
      }
      return null;
    } catch {
      return null;
    }
  }

  function middleware(req: IncomingMessage, res: ServerResponse, next: (err?: unknown) => void): void {
    const rawUrl = req.url ?? "";
    let pathname = "";
    try {
      pathname = new URL(rawUrl, "http://127.0.0.1").pathname;
    } catch {
      next();
      return;
    }

    if (pathname !== "/api/suggest-gecko-pool" || req.method !== "POST") {
      next();
      return;
    }

    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      void (async () => {
        try {
          const text = Buffer.concat(chunks).toString("utf8").trim();
          const body = text.length > 0 ? (JSON.parse(text) as { mint?: string }) : {};
          const mint = typeof body.mint === "string" ? body.mint.trim() : "";
          if (!looksLikeSolanaAddressBase58(mint)) {
            res.statusCode = 400;
            res.setHeader("Content-Type", "application/json; charset=utf-8");
            res.end(JSON.stringify({ ok: false, error: "Invalid or missing `mint` (expect Solana base58 token mint)." }));
            return;
          }

          const dexPicks = await fetchDexScreenerRankedPools(mint, MAX_SUGGESTED_POOLS);
          if (dexPicks.length > 0) {
            const pools = suggestedRowsFromDexPicks(dexPicks);
            const top = pools[0];
            res.statusCode = 200;
            res.setHeader("Content-Type", "application/json; charset=utf-8");
            res.end(
              JSON.stringify({
                ok: true,
                mint,
                pools,
                poolAddress: top.poolAddress,
                pairHint: top.pairHint,
                notes: top.notes,
                source: "dexscreener",
              }),
            );
            return;
          }

          const geckoPicks = await fetchGeckoTerminalRankedPools(mint, MAX_SUGGESTED_POOLS);
          if (geckoPicks.length > 0) {
            const pools = suggestedRowsFromDexPicks(geckoPicks);
            const top = pools[0];
            res.statusCode = 200;
            res.setHeader("Content-Type", "application/json; charset=utf-8");
            res.end(
              JSON.stringify({
                ok: true,
                mint,
                pools,
                poolAddress: top.poolAddress,
                pairHint: top.pairHint,
                notes: top.notes,
                source: "geckoterminal",
              }),
            );
            return;
          }

          if (key.length === 0) {
            res.statusCode = 200;
            res.setHeader("Content-Type", "application/json; charset=utf-8");
            res.end(
              JSON.stringify({
                ok: false,
                mint,
                pools: [],
                error:
                  "No pools found via DexScreener or GeckoTerminal. Set PERPLEXITY_API_KEY in apps/chart-web/.env (or the shell) and restart Vite for AI fallback.",
              }),
            );
            return;
          }

          const prompt = buildGeckoPoolSuggestPrompt(mint);
          const t0 = Date.now();
          const upstream = await forwardToPerplexity(prompt);
          await enforceMinimumElapsed(t0, minMs);

          if (upstream.status < 200 || upstream.status >= 300) {
            res.statusCode = 502;
            res.setHeader("Content-Type", "application/json; charset=utf-8");
            res.end(
              JSON.stringify({
                ok: false,
                error: `Perplexity HTTP ${upstream.status}`,
                upstreamHttpStatus: upstream.status,
                rawSnippet: upstream.body.slice(0, 400),
              }),
            );
            return;
          }

          const assistantRaw = extractAssistantText(upstream.body);
          if (assistantRaw === null || assistantRaw.length === 0) {
            res.statusCode = 502;
            res.setHeader("Content-Type", "application/json; charset=utf-8");
            res.end(JSON.stringify({ ok: false, error: "Empty response from Perplexity.", rawSnippet: upstream.body.slice(0, 400) }));
            return;
          }

          const classified = classifyGeckoPoolAssistantJson(assistantRaw, mint);
          if (classified.outcome === "pool") {
            const pools: SuggestedPoolRow[] = [
              {
                rank: 1,
                poolAddress: classified.poolAddress,
                pairHint: classified.pairHint ?? "",
                notes: classified.notes ?? "",
              },
            ];
            const top = pools[0];
            res.statusCode = 200;
            res.setHeader("Content-Type", "application/json; charset=utf-8");
            res.end(
              JSON.stringify({
                ok: true,
                mint,
                pools,
                poolAddress: top.poolAddress,
                pairHint: top.pairHint.length > 0 ? top.pairHint : undefined,
                notes: top.notes.length > 0 ? top.notes : undefined,
                source: "perplexity",
              }),
            );
            return;
          }
          if (classified.outcome === "no_pool") {
            res.statusCode = 200;
            res.setHeader("Content-Type", "application/json; charset=utf-8");
            res.end(
              JSON.stringify({
                ok: false,
                mint,
                pools: [],
                error: "Perplexity did not return a usable pool address for this mint.",
                notes: classified.notes,
                pairHint: classified.pairHint,
              }),
            );
            return;
          }

          res.statusCode = 502;
          res.setHeader("Content-Type", "application/json; charset=utf-8");
          res.end(
            JSON.stringify({
              ok: false,
              error: "Could not parse pool JSON from model output.",
              rawSnippet: assistantRaw.slice(0, 800),
            }),
          );
        } catch (e) {
          res.statusCode = 500;
          res.setHeader("Content-Type", "application/json; charset=utf-8");
          res.end(JSON.stringify({ ok: false, error: e instanceof Error ? e.message : String(e) }));
        }
      })();
    });
  }

  return {
    name: "sol-bot-perplexity-suggest-pool",
    enforce: "pre",
    configureServer(server) {
      server.middlewares.use(middleware);
    },
    configurePreviewServer(server) {
      server.middlewares.use(middleware);
    },
  };
}
