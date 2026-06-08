/**
 * PM2: chart desks (`npm run dev` in apps/chart-web).
 * Default: 7 instances → ports 5713–5719 (chart-web-1 … chart-web-7).
 * Optional env files set VITE_* overrides — mainly `VITE_DESK_PRIVATE_KEY` per wallet.
 *
 * Why 7: the GeckoTerminal public API is rate-limited per IP (≈ 10–30 req/min, shared across
 * every instance on this machine). Each instance polls once per ~60 s; PM2 hands every instance
 * the total count + base port (CHART_WEB_INSTANCE_COUNT / CHART_WEB_BASE_PORT) so the browser
 * can evenly stagger its polls across the minute and never burst past the public limit.
 * `CHART_WEB_INSTANCE_COUNT` below is the single source of truth — bump it and the stagger adapts.
 *
 * Setup:
 *   cd repo && npm install && npm --prefix apps/chart-web install
 *   for i in $(seq 1 7); do cp deploy/chart-web-pm2-env/chart-web-$i.example.env deploy/chart-web-pm2-env/chart-web-$i.env; done
 *   Edit each chart-web-{n}.env with its desk secret key (never commit *.env).
 *   npm run chart:pm2:start
 *
 * If you change chart-web-*.env, reload env into PM2: `pm2 restart chart-web-1 chart-web-2 … chart-web-7 --update-env`
 * (or delete + start again). Vite reads VITE_* only when the dev process starts.
 *
 * Signal history (JSONL): `apps/chart-web/positions-{CHART_WEB_PORT}.txt` — one file per PM2 app (5713…5719).
 *
 * Each chart-web-*.env may include CHART_WEB_PORT (for visibility); PM2 always sets the real listen port last.
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");

/** Minimal KEY=VAL (.env style); skips blanks and # comments; strips surrounding quotes. */
function parseEnvFile(filePath) {
  /** @type {Record<string, string>} */
  const out = {};
  if (!fs.existsSync(filePath)) {
    return out;
  }
  const text = fs.readFileSync(filePath, "utf8");
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) {
      continue;
    }
    const eq = line.indexOf("=");
    if (eq <= 0) {
      continue;
    }
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (key.length > 0) {
      out[key] = val;
    }
  }
  return out;
}

const deployDir = __dirname;
const repoRoot = path.resolve(deployDir, "..");
const chartWeb = path.join(repoRoot, "apps", "chart-web");
const envDir = path.join(deployDir, "chart-web-pm2-env");

/** Number of parallel chart-web PM2 apps (chart-web-1 … chart-web-N). Ports = BASE_PORT … BASE_PORT + N - 1. */
const CHART_WEB_INSTANCE_COUNT = 7;
const BASE_PORT = 5713;

const instances = Array.from({ length: CHART_WEB_INSTANCE_COUNT }, (_, i) => {
  const n = i + 1;
  return {
    name: `chart-web-${n}`,
    port: BASE_PORT + i,
    envFile: `chart-web-${n}.env`,
  };
});

module.exports = {
  apps: instances.map(({ name, port, envFile }) => ({
    name,
    cwd: chartWeb,
    script: "npm",
    args: "run dev",
    interpreter: "none",
    instances: 1,
    exec_mode: "fork",
    autorestart: true,
    max_restarts: 50,
    min_uptime: "5s",
    merge_logs: true,
    env: {
      NODE_ENV: "development",
      ...parseEnvFile(path.join(envDir, envFile)),
      CHART_WEB_STRICT_PORT: "1",
      CHART_WEB_PORT: String(port),
      // Hand the browser the fleet shape so it can evenly stagger GeckoTerminal polls (no 429 bursts).
      CHART_WEB_INSTANCE_COUNT: String(CHART_WEB_INSTANCE_COUNT),
      CHART_WEB_BASE_PORT: String(BASE_PORT),
    },
  })),
};
