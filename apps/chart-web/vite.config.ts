import dns from "node:dns";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, loadEnv, type Plugin, type ProxyOptions } from "vite";

/** VMware / broken IPv6: prefer A records so `getaddrinfo` does not hang or fail on AAAA-only paths. */
dns.setDefaultResultOrder("ipv4first");

const botSrc = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../src");
const chartRoot = path.dirname(fileURLToPath(import.meta.url));

function jupiterProxyConfig(targetBase: string): Record<string, ProxyOptions> {
  const target = targetBase.replace(/\/$/, "");
  return {
    "/jupiter-api": {
      target,
      changeOrigin: true,
      secure: true,
      rewrite: (p: string) => p.replace(/^\/jupiter-api/, "/v6"),
      timeout: 120_000,
      proxyTimeout: 120_000,
    },
  };
}

/** Dev-only: append/read `positions.txt` for BUY/SELL JSONL (static hosting has no server write). */
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
        res.statusCode = 405;
        res.end();
      });
    },
  };
}

export default defineConfig(({ mode }) => {
  const fileEnv = loadEnv(mode, chartRoot, "");
  const jupiterTarget =
    fileEnv.JUPITER_API_PROXY_TARGET?.trim() ||
    process.env.JUPITER_API_PROXY_TARGET?.trim() ||
    "https://quote-api.jup.ag";

  const jupiter = jupiterProxyConfig(jupiterTarget);

  return {
    plugins: [positionsFileApi()],
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
      proxy: {
        ...jupiter,
        // Optional fallback if something must hit same-origin; chart-web uses direct HTTPS + CORS.
        "/gt-api": {
          target: "https://api.geckoterminal.com",
          changeOrigin: true,
          rewrite: (p) => p.replace(/^\/gt-api/, "/api/v2"),
          timeout: 120_000,
          proxyTimeout: 120_000,
        },
      },
    },
    preview: {
      host: "0.0.0.0",
      proxy: {
        ...jupiter,
      },
    },
  };
});
