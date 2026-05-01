/**
 * Vite dev / preview middleware: POST `/api/suggest-gecko-pool` → Perplexity Sonar (OpenAI-compatible).
 * Requires `PERPLEXITY_API_KEY` in the environment or `apps/chart-web/.env` (never `VITE_*`).
 */

import https from "node:https";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Plugin } from "vite";

const upstreamAgent = new https.Agent({ family: 4, keepAlive: true });

const PERPLEXITY_HOST = "api.perplexity.ai";
/** Perplexity Sonar chat completions — canonical path (OpenAI SDK alias is `/chat/completions`, not `/v1/chat/completions`). */
const PERPLEXITY_CHAT_PATH = "/v1/sonar";

export function looksLikeSolanaAddressBase58(s: string): boolean {
  const t = s.trim();
  if (t.length < 32 || t.length > 48) {
    return false;
  }
  return /^[1-9A-HJ-NP-Za-km-z]+$/.test(t);
}

export function buildGeckoPoolSuggestPrompt(tokenMint: string): string {
  return [
    `Solana SPL token mint (base58): ${tokenMint}`,
    "",
    "Task: Identify the single most reasonable on-chain liquidity pool for this token on Solana mainnet for charting OHLCV. You must google search.",
    "Prefer the highest-liquidity / most-traded pair",
    "",
    "Reply with ONLY a JSON object (no markdown fences, no commentary) in this exact shape:",
    '{"poolAddress":"<GeckoTerminal Solana pool address — base58 string>","pairHint":"<e.g. TOKEN/SOL>","notes":"<one short sentence why>"}',
    "",
    "poolAddress must be the pool id string uses in URLs like /networks/solana/pools/{poolAddress}/ — not the token mint.",
  ].join("\n");
}

export function parseGeckoPoolJsonFromAssistant(raw: string): {
  poolAddress: string;
  pairHint?: string;
  notes?: string;
} | null {
  const t = raw.trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = (fence ? fence[1] : t)?.trim() ?? "";
  try {
    const o = JSON.parse(candidate) as Record<string, unknown>;
    const addr = typeof o.poolAddress === "string" ? o.poolAddress.trim() : "";
    if (!looksLikeSolanaAddressBase58(addr)) {
      return null;
    }
    return {
      poolAddress: addr,
      pairHint: typeof o.pairHint === "string" ? o.pairHint.trim() : undefined,
      notes: typeof o.notes === "string" ? o.notes.trim() : undefined,
    };
  } catch {
    return null;
  }
}

/** POST JSON body `{ mint: string }` — forwards to Perplexity and returns `{ ok, poolAddress?, pairHint?, notes?, rawSnippet?, error? }`. */
export function perplexitySuggestPoolPlugin(apiKey: string, model: string): Plugin {
  const key = apiKey.trim();
  const mdl = model.trim() || "sonar";

  async function forwardToPerplexity(userContent: string): Promise<{ status: number; body: string }> {
    const payload = JSON.stringify({
      model: mdl,
      temperature: 0.15,
      max_tokens: 512,
      messages: [
        {
          role: "system",
          content:
            "You are a precise crypto data assistant. Output must be valid JSON only — no markdown, no prose outside the JSON object.",
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
        choices?: ReadonlyArray<{ message?: { content?: string } }>;
      };
      const c = o.choices?.[0]?.message?.content;
      return typeof c === "string" ? c : null;
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

    if (key.length === 0) {
      res.statusCode = 503;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.end(
        JSON.stringify({
          ok: false,
          error:
            "PERPLEXITY_API_KEY is not set. Add it to apps/chart-web/.env or the shell environment and restart Vite.",
        }),
      );
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

          const prompt = buildGeckoPoolSuggestPrompt(mint);
          const upstream = await forwardToPerplexity(prompt);

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

          const parsed = parseGeckoPoolJsonFromAssistant(assistantRaw);
          if (parsed === null) {
            res.statusCode = 502;
            res.setHeader("Content-Type", "application/json; charset=utf-8");
            res.end(
              JSON.stringify({
                ok: false,
                error: "Could not parse pool JSON from model output.",
                rawSnippet: assistantRaw.slice(0, 800),
              }),
            );
            return;
          }

          res.statusCode = 200;
          res.setHeader("Content-Type", "application/json; charset=utf-8");
          res.end(JSON.stringify({ ok: true, mint, ...parsed }));
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
