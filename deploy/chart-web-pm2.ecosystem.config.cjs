/**
 * PM2: five chart desks (`npm run dev` in apps/chart-web), ports 5713–5717.
 * Optional env files set VITE_* overrides — mainly `VITE_DESK_PRIVATE_KEY` per wallet.
 *
 * Setup:
 *   cd repo && npm install && npm --prefix apps/chart-web install
 *   for i in 1 2 3 4 5; do cp deploy/chart-web-pm2-env/chart-web-$i.example.env deploy/chart-web-pm2-env/chart-web-$i.env; done
 *   Edit each chart-web-{n}.env with its desk secret key (never commit *.env).
 *   npm run chart:pm2:start
 *
 * If you change chart-web-*.env, reload env into PM2: `pm2 restart chart-web-1 chart-web-2 … --update-env`
 * (or delete + start again). Vite reads VITE_* only when the dev process starts.
 *
 * Shared RPC/Jupiter settings usually stay in apps/chart-web/.env — PM2 vars override where duplicated.
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

const instances = [
  { name: "chart-web-1", port: 5713, envFile: "chart-web-1.env" },
  { name: "chart-web-2", port: 5714, envFile: "chart-web-2.env" },
  { name: "chart-web-3", port: 5715, envFile: "chart-web-3.env" },
  { name: "chart-web-4", port: 5716, envFile: "chart-web-4.env" },
  { name: "chart-web-5", port: 5717, envFile: "chart-web-5.env" },
];

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
    },
  })),
};
