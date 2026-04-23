import dns from "node:dns";
import fs from "node:fs";
import https from "node:https";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, loadEnv, type Plugin } from "vite";

/** VMware / broken IPv6: prefer A records so `getaddrinfo` does not hang or fail on AAAA-only paths. */
dns.setDefaultResultOrder("ipv4first");

/**
 * Outgoing HTTPS connections for upstream APIs.
 * `family: 4` avoids broken IPv6-only routes when the host resolves to AAAA first or IPv6 is down.
 */
const upstreamHttpsAgent = new https.Agent({ family: 4, keepAlive: true });

const botSrc = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../src");
const chartRoot = path.dirname(fileURLToPath(import.meta.url));

const DEFAULT_JUPITER_PROXY_ORIGIN = "https://api.jup.ag";

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailers",
  "transfer-encoding",
  "upgrade",
]);

/**
 * `https.request` target origin only (no `/swap/v1` path) so env cannot double the API prefix.
 */
function jupiterProxyOrigin(raw: string): string {
  const t = raw.trim();
  if (t.length === 0) {
    return DEFAULT_JUPITER_PROXY_ORIGIN;
  }
  try {
    const u = new URL(t);
    return `${u.protocol}//${u.host}`;
  } catch {
    return t.replace(/\/$/, "");
  }
}

/**
 * DNS for the Vite Node process (Jupiter / Gecko proxy).
 * Defaults to the **OS resolver** — forcing 8.8.8.8/1.1.1.1 breaks on networks that block DNS to those IPs
 * (`getaddrinfo ENOTFOUND` for every upstream host).
 *
 * Opt in to fixed public DNS for broken VMs / bad corporate resolvers: `CHART_WEB_USE_PUBLIC_DNS=1`.
 * `CHART_WEB_DNS_SERVERS` still overrides the server list when set (comma-separated).
 */
function applyChartWebDns(fileEnv: Record<string, string>): void {
  const forceSystem =
    fileEnv.CHART_WEB_USE_SYSTEM_DNS?.trim() === "1" ||
    process.env.CHART_WEB_USE_SYSTEM_DNS?.trim() === "1";
  if (forceSystem) {
    return;
  }
  const raw =
    fileEnv.CHART_WEB_DNS_SERVERS?.trim() ??
    process.env.CHART_WEB_DNS_SERVERS?.trim() ??
    "";
  const usePublic =
    fileEnv.CHART_WEB_USE_PUBLIC_DNS?.trim() === "1" ||
    process.env.CHART_WEB_USE_PUBLIC_DNS?.trim() === "1";
  const servers =
    raw.length > 0
      ? raw.split(/[,;\s]+/).map((s) => s.trim()).filter((s) => s.length > 0)
      : usePublic
        ? ["8.8.8.8", "1.1.1.1"]
        : null;
  if (servers === null || servers.length === 0) {
    return;
  }
  try {
    dns.setServers(servers);
  } catch {
    /* invalid CHART_WEB_DNS_SERVERS — keep system resolver */
  }
}

function forwardRequestHeaders(req: IncomingMessage, upstreamHost: string): NodeJS.Dict<string | string[] | undefined> {
  const out: Record<string, string | string[] | undefined> = { host: upstreamHost };
  for (const [k, v] of Object.entries(req.headers)) {
    if (v === undefined) continue;
    const low = k.toLowerCase();
    if (HOP_BY_HOP.has(low) || low === "host") continue;
    out[k] = v;
  }
  return out;
}

/** Headers forwarded to Jupiter: drop browser-only / hop-adjacent noise (not needed for quote/swap APIs). */
function jupiterUpstreamRequestHeaders(
  req: IncomingMessage,
  upstreamHost: string,
): NodeJS.Dict<string | string[] | undefined> {
  const raw = forwardRequestHeaders(req, upstreamHost);
  const out: Record<string, string | string[] | undefined> = { host: upstreamHost };
  for (const [k, v] of Object.entries(raw)) {
    if (v === undefined) continue;
    const low = k.toLowerCase();
    if (low === "cookie" || low === "referer" || low === "origin" || low.startsWith("sec-")) {
      continue;
    }
    out[k] = v;
  }
  return out;
}

/**
 * `/jupiter-api/quote?…` → `https://api.jup.ag/swap/v1/quote?…` (Swap API v1).
 * Custom middleware avoids Vite's built-in http-proxy `http proxy error` console spam on failure.
 */
function jupiterUpstreamPath(pathname: string, search: string): string {
  const stripped = pathname.replace(/^\/jupiter-api/, "") || "/";
  if (stripped.startsWith("/swap/v1")) {
    return `${stripped}${search}`;
  }
  return `/swap/v1${stripped.startsWith("/") ? stripped : `/${stripped}`}${search}`;
}

function jupiterDevProxyPlugin(targetRaw: string, swapApiKey: string): Plugin {
  const originStr = jupiterProxyOrigin(targetRaw);
  let upstreamHost = "api.jup.ag";
  let upstreamPort = 443;
  try {
    const o = new URL(originStr);
    upstreamHost = o.hostname;
    upstreamPort = o.port === "" ? 443 : Number(o.port);
  } catch {
    /* keep defaults */
  }

  function jupiterMiddleware(req: IncomingMessage, res: ServerResponse, next: (err?: unknown) => void): void {
    const urlRaw = req.url ?? "";
    if (!urlRaw.startsWith("/jupiter-api")) {
      next();
      return;
    }

    let pathWithSearch: string;
    try {
      const u = new URL(urlRaw, "http://127.0.0.1");
      pathWithSearch = jupiterUpstreamPath(u.pathname, u.search);
    } catch {
      if (!res.headersSent) {
        res.statusCode = 400;
        res.end();
      }
      return;
    }

    const headers = jupiterUpstreamRequestHeaders(req, upstreamHost);
    if (swapApiKey.length > 0) {
      headers["x-api-key"] = swapApiKey;
    }

    const opt: https.RequestOptions = {
      hostname: upstreamHost,
      port: upstreamPort,
      path: pathWithSearch,
      method: req.method,
      headers,
      agent: upstreamHttpsAgent,
    };

    const outgoing = https.request(opt, (upRes) => {
      res.statusCode = upRes.statusCode ?? 502;
      for (const [key, val] of Object.entries(upRes.headers)) {
        if (val === undefined) continue;
        const low = key.toLowerCase();
        if (HOP_BY_HOP.has(low)) continue;
        res.setHeader(key, val);
      }
      upRes.on("error", () => {
        if (!res.writableEnded) {
          res.destroy();
        }
      });
      upRes.pipe(res);
    });

    outgoing.on("error", (err: NodeJS.ErrnoException) => {
      // Typical: ENOTFOUND / EAI_AGAIN (DNS), ETIMEDOUT, ECONNRESET, TLS errors — see CHART_WEB_* env in .env.example.
      console.error(
        "[sol-bot-jupiter-dev-proxy] upstream HTTPS failed:",
        err.message,
        err.code ? `(${err.code})` : "",
        `→ https://${upstreamHost}${pathWithSearch}`,
      );
      if (res.headersSent || res.writableEnded) {
        return;
      }
      res.statusCode = 502;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.end("{}");
    });

    req.on("aborted", () => {
      outgoing.destroy();
    });

    req.pipe(outgoing);
  }

  return {
    name: "sol-bot-jupiter-dev-proxy",
    enforce: "pre",
    configureServer(server) {
      server.middlewares.use(jupiterMiddleware);
    },
    configurePreviewServer(server) {
      server.middlewares.use(jupiterMiddleware);
    },
  };
}

/** Dev-only: append/read `positions.txt` for BUY/SELL JSONL (static hosting has no server write). */
/**
 * Dev server port (Vite). Default 5713 matches common VPS + Caddy reverse_proxy targets.
 * Override with `CHART_WEB_PORT` in `apps/chart-web/.env` or the environment.
 */
function chartWebDevPort(fileEnv: Record<string, string>): number {
  const raw = (fileEnv.CHART_WEB_PORT ?? process.env.CHART_WEB_PORT ?? "").trim();
  if (raw === "") {
    return 5713;
  }
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 && n < 65536 ? n : 5713;
}

/**
 * Hosts allowed in the `Host` header (required when opening the dev server via a real domain behind Caddy).
 * - unset: Vite default (localhost-style only) — use for pure localhost access.
 * - comma-separated hostnames: e.g. `dexfilter.xyz,www.dexfilter.xyz`
 * - `all` or `*`: allow any host (convenient but broad; dev-only).
 */
function chartWebAllowedHosts(fileEnv: Record<string, string>): true | string[] | undefined {
  const raw = (fileEnv.CHART_WEB_ALLOWED_HOSTS ?? process.env.CHART_WEB_ALLOWED_HOSTS ?? "").trim();
  if (raw === "") {
    return undefined;
  }
  if (raw === "all" || raw === "*") {
    return true as const;
  }
  const hosts = raw
    .split(/[,;]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return hosts.length > 0 ? hosts : undefined;
}

/**
 * When the app is served at a public URL (e.g. `https://dexfilter.xyz` via Caddy), set
 * `CHART_WEB_PUBLIC_ORIGIN` so HMR uses `wss` on port 443 instead of trying to reach :5713 from the browser.
 *
 * If you develop at `http://localhost:...` but keep `CHART_WEB_PUBLIC_ORIGIN` in `.env` (for copy-paste
 * to a VPS), set `CHART_WEB_USE_LOCAL_HMR=1` so the client does not try `wss` to the public host.
 */
function chartWebHmrConfig(
  fileEnv: Record<string, string>,
): { protocol: "ws" | "wss"; host: string; clientPort: number } | undefined {
  const useLocalHmr =
    (fileEnv.CHART_WEB_USE_LOCAL_HMR ?? process.env.CHART_WEB_USE_LOCAL_HMR ?? "").trim() === "1";
  if (useLocalHmr) {
    return undefined;
  }
  const raw = (fileEnv.CHART_WEB_PUBLIC_ORIGIN ?? process.env.CHART_WEB_PUBLIC_ORIGIN ?? "").trim();
  if (raw === "") {
    return undefined;
  }
  try {
    const u = new URL(raw);
    const https = u.protocol === "https:";
    const port =
      u.port === "" ? (https ? 443 : 80) : Number(u.port);
    if (!Number.isFinite(port)) {
      return undefined;
    }
    return {
      protocol: https ? "wss" : "ws",
      host: u.hostname,
      clientPort: port,
    };
  } catch {
    return undefined;
  }
}

function positionsFileApi(): Plugin {
  const positionsFile = path.join(chartRoot, "positions.txt");
  return {
    name: "sol-bot-positions-file",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = (req.url ?? "").split("?")[0] ?? "";
        if (url !== "/api/positions") {
          next();
          return;
        }
        if (req.method === "GET") {
          try {
            const body = fs.existsSync(positionsFile) ? fs.readFileSync(positionsFile, "utf8") : "";
            res.statusCode = 200;
            res.setHeader("Content-Type", "text/plain; charset=utf-8");
            res.end(body);
          } catch (e) {
            res.statusCode = 500;
            res.end(e instanceof Error ? e.message : String(e));
          }
          return;
        }
        if (req.method === "POST") {
          const chunks: Buffer[] = [];
          req.on("data", (c: Buffer) => {
            chunks.push(c);
          });
          req.on("end", () => {
            try {
              const line = Buffer.concat(chunks).toString("utf8").trimEnd();
              if (line.length > 0) {
                fs.appendFileSync(positionsFile, `${line}\n`, "utf8");
              }
              res.statusCode = 204;
              res.end();
            } catch (e) {
              res.statusCode = 500;
              res.end(e instanceof Error ? e.message : String(e));
            }
          });
          return;
        }
        if (req.method === "PUT") {
          const chunks: Buffer[] = [];
          req.on("data", (c: Buffer) => {
            chunks.push(c);
          });
          req.on("end", () => {
            try {
              const body = Buffer.concat(chunks).toString("utf8");
              fs.writeFileSync(positionsFile, body, "utf8");
              res.statusCode = 204;
              res.end();
            } catch (e) {
              res.statusCode = 500;
              res.end(e instanceof Error ? e.message : String(e));
            }
          });
          return;
        }
        res.statusCode = 405;
        res.end();
      });
    },
  };
}

export default defineConfig(({ mode }) => {
  const fileEnv = loadEnv(mode, chartRoot, "");
  applyChartWebDns(fileEnv);

  const jupiterTargetRaw =
    fileEnv.JUPITER_API_PROXY_TARGET?.trim() ||
    process.env.JUPITER_API_PROXY_TARGET?.trim() ||
    DEFAULT_JUPITER_PROXY_ORIGIN;

  const jupiterSwapApiKey =
    fileEnv.JUPITER_SWAP_API_KEY?.trim() ?? process.env.JUPITER_SWAP_API_KEY?.trim() ?? "";

  const devPort = chartWebDevPort(fileEnv);
  const allowedHosts = chartWebAllowedHosts(fileEnv);
  const hmrPublic = chartWebHmrConfig(fileEnv);

  return {
    plugins: [jupiterDevProxyPlugin(jupiterTargetRaw, jupiterSwapApiKey), positionsFileApi()],
    resolve: {
      alias: {
        "@bot": botSrc,
        buffer: "buffer",
      },
    },
    optimizeDeps: {
      include: ["buffer", "@solana/web3.js"],
    },
    server: {
      host: "0.0.0.0",
      port: devPort,
      strictPort: (fileEnv.CHART_WEB_STRICT_PORT ?? process.env.CHART_WEB_STRICT_PORT ?? "").trim() === "1",
      ...(allowedHosts !== undefined ? { allowedHosts } : {}),
      ...(hmrPublic !== undefined ? { hmr: hmrPublic } : {}),
      proxy: {
        "/gt-api": {
          target: "https://api.geckoterminal.com",
          changeOrigin: true,
          secure: true,
          agent: upstreamHttpsAgent,
          rewrite: (p) => p.replace(/^\/gt-api/, "/api/v2"),
          timeout: 120_000,
          proxyTimeout: 120_000,
        },
      },
    },
    preview: {
      host: "0.0.0.0",
      proxy: {
        "/gt-api": {
          target: "https://api.geckoterminal.com",
          changeOrigin: true,
          secure: true,
          agent: upstreamHttpsAgent,
          rewrite: (p) => p.replace(/^\/gt-api/, "/api/v2"),
          timeout: 120_000,
          proxyTimeout: 120_000,
        },
      },
    },
  };
});
