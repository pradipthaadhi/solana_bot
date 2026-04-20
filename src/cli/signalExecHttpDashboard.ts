/**
 * Optional localhost dashboard for `npm run signal:jupiter` (read-only status + recent swaps).
 */

import http from "node:http";
import type { AgentTickResult } from "../agent/signalAgent.js";
import type { ExecuteJupiterSwapResult } from "../execution/swapExecutor.js";

export interface SignalExecDashboardSnapshot {
  startedAtIso: string;
  walletPubkey: string;
  mode: string;
  simulateOnly: boolean;
  /** True when on-chain sends are allowed by policy (MODE=live, simulate off, kill switch off). */
  realSolTransactionsEnabled: boolean;
  poolAddress: string;
  tokenMint: string | undefined;
  pollMs: number;
  lastTickAtIso: string | null;
  lastTickOk: boolean | null;
  lastTickError: string | null;
  lastBarCount: number | null;
  swaps: Array<{
    tsIso: string;
    leg: "entry" | "exit";
    simulateOnly: boolean;
    hasSignature: boolean;
    signature?: string;
  }>;
}

const MAX_SWAPS = 40;

function pageHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>sol_bot — signal execution</title>
  <style>
    :root { font-family: system-ui, sans-serif; background: #0f1419; color: #e7e9ea; }
    body { margin: 0; padding: 1.25rem; max-width: 52rem; }
    h1 { font-size: 1.15rem; font-weight: 600; margin: 0 0 0.75rem; }
    .banner { padding: 0.65rem 0.85rem; border-radius: 8px; margin-bottom: 1rem; font-size: 0.95rem; }
    .sim { background: #1d3b5c; border: 1px solid #2b5a8a; }
    .live { background: #3d2914; border: 1px solid #8a5c2b; color: #ffd7a8; }
    table { width: 100%; border-collapse: collapse; font-size: 0.85rem; }
    th, td { text-align: left; padding: 0.4rem 0.5rem; border-bottom: 1px solid #2f3336; }
    th { color: #8b98a5; font-weight: 500; }
    .muted { color: #8b98a5; font-size: 0.8rem; margin-top: 1rem; }
    code { font-size: 0.78rem; word-break: break-all; }
    a { color: #1d9bf0; }
  </style>
</head>
<body>
  <h1>Signal → Jupiter status</h1>
  <div id="banner" class="banner">Loading…</div>
  <table>
    <tbody id="meta"></tbody>
  </table>
  <p class="muted">Recent swaps (entry = BUY SOL→token, exit = SELL token→SOL)</p>
  <table>
    <thead><tr><th>Time</th><th>Leg</th><th>Mode</th><th>Tx</th></tr></thead>
    <tbody id="swaps"></tbody>
  </table>
  <p class="muted">Refreshes every 3s · <code>GET /api/status</code></p>
  <script>
    function row(label, value) {
      return '<tr><th>' + label + '</th><td>' + value + '</td></tr>';
    }
    async function refresh() {
      const r = await fetch('/api/status');
      const s = await r.json();
      const real = s.realSolTransactionsEnabled;
      const b = document.getElementById('banner');
      if (real) {
        b.className = 'banner live';
        b.textContent = 'LIVE: on-chain broadcasts are enabled (real SOL spends possible on signals).';
      } else {
        b.className = 'banner sim';
        b.textContent = 'Simulation / dry-run: Jupiter quote + RPC simulate only — no mainnet broadcast with current .env.';
      }
      const tick = s.lastTickAtIso
        ? (s.lastTickOk ? 'OK' : 'FAIL') + ' · ' + s.lastTickAtIso + (s.lastBarCount != null ? ' · bars: ' + s.lastBarCount : '')
        : '—';
      const err = s.lastTickError ? '<br><code style="color:#f91880">' + escapeHtml(s.lastTickError) + '</code>' : '';
      document.getElementById('meta').innerHTML =
        row('Wallet', '<code>' + s.walletPubkey + '</code>') +
        row('MODE', escapeHtml(s.mode)) +
        row('SIGNAL_EXEC_SIMULATE_ONLY', s.simulateOnly ? '1 (simulate)' : '0 (would sign+send if LIVE)') +
        row('Pool', '<code>' + escapeHtml(s.poolAddress) + '</code>') +
        row('TOKEN_MINT', s.tokenMint ? '<code>' + escapeHtml(s.tokenMint) + '</code>' : '—') +
        row('Last tick', tick + err);
      const body = document.getElementById('swaps');
      if (s.swaps.length === 0) {
        body.innerHTML = '<tr><td colspan="4">No swap attempts yet (signals in tail window trigger swaps).</td></tr>';
      } else {
        body.innerHTML = s.swaps.map(function (w) {
          var mode = w.simulateOnly ? 'simulate' : 'live send';
          var tx = w.hasSignature && w.signature
            ? '<a href="https://solscan.io/tx/' + encodeURIComponent(w.signature) + '" target="_blank" rel="noopener">' + escapeHtml(w.signature.slice(0, 12)) + '…</a>'
            : (w.simulateOnly ? 'sim OK' : '—');
          return '<tr><td>' + escapeHtml(w.tsIso) + '</td><td>' + w.leg + '</td><td>' + mode + '</td><td>' + tx + '</td></tr>';
        }).join('');
      }
    }
    function escapeHtml(t) {
      return String(t).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    }
    refresh();
    setInterval(refresh, 3000);
  </script>
</body>
</html>`;
}

export function createSignalExecDashboard(params: {
  walletPubkey: string;
  mode: string;
  simulateOnly: boolean;
  killSwitch: boolean;
  poolAddress: string;
  tokenMint: string | undefined;
  pollMs: number;
}): {
  snapshot: SignalExecDashboardSnapshot;
  recordTick(result: AgentTickResult): void;
  recordSwap(result: ExecuteJupiterSwapResult, leg: "entry" | "exit", simulateOnly: boolean): void;
  startHttpServer(port: number): { port: number; close: () => void };
} {
  const realSolTransactionsEnabled = params.mode === "live" && !params.simulateOnly && !params.killSwitch;

  const snapshot: SignalExecDashboardSnapshot = {
    startedAtIso: new Date().toISOString(),
    walletPubkey: params.walletPubkey,
    mode: params.mode,
    simulateOnly: params.simulateOnly,
    realSolTransactionsEnabled,
    poolAddress: params.poolAddress,
    tokenMint: params.tokenMint,
    pollMs: params.pollMs,
    lastTickAtIso: null,
    lastTickOk: null,
    lastTickError: null,
    lastBarCount: null,
    swaps: [],
  };

  const recordTick = (result: AgentTickResult): void => {
    const ts = new Date().toISOString();
    snapshot.lastTickAtIso = ts;
    if (result.ok) {
      snapshot.lastTickOk = true;
      snapshot.lastTickError = null;
      snapshot.lastBarCount = result.bars.length;
    } else {
      snapshot.lastTickOk = false;
      snapshot.lastTickError = result.error;
      snapshot.lastBarCount = null;
    }
  };

  const recordSwap = (result: ExecuteJupiterSwapResult, leg: "entry" | "exit", simulateOnly: boolean): void => {
    const row: SignalExecDashboardSnapshot["swaps"][number] = {
      tsIso: new Date().toISOString(),
      leg,
      simulateOnly,
      hasSignature: Boolean(result.signature),
    };
    if (result.signature !== undefined) {
      row.signature = result.signature;
    }
    snapshot.swaps.unshift(row);
    if (snapshot.swaps.length > MAX_SWAPS) {
      snapshot.swaps.length = MAX_SWAPS;
    }
  };

  const startHttpServer = (port: number): { port: number; close: () => void } => {
    const server = http.createServer((req, res) => {
      if (req.url === "/" || req.url === "/index.html") {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(pageHtml());
        return;
      }
      if (req.url === "/api/status" || req.url?.startsWith("/api/status?")) {
        res.writeHead(200, {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "no-store",
        });
        res.end(JSON.stringify(snapshot));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    server.listen(port, "127.0.0.1", () => {
      // eslint-disable-next-line no-console
      console.log(
        JSON.stringify({
          kind: "SIGNAL_EXEC_DASHBOARD_LISTEN",
          url: `http://127.0.0.1:${String(port)}/`,
        }),
      );
    });
    return {
      port,
      close: () => {
        server.close();
      },
    };
  };

  return { snapshot, recordTick, recordSwap, startHttpServer };
}
