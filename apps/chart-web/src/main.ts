import "./polyfills.js";
import "./style.css";
import { Connection, LAMPORTS_PER_SOL } from "@solana/web3.js";
import {
  ColorType,
  CrosshairMode,
  createChart,
  type CandlestickData,
  type HistogramData,
  type IChartApi,
  type LineData,
  type Logical,
  type LogicalRange,
  type Range,
  type SeriesMarker,
  type Time,
  type UTCTimestamp,
} from "lightweight-charts";
import { SignalAgent } from "@bot/agent/signalAgent.js";
import {
  describeOhlcvFetchError,
  fetchSolanaPoolOhlcv1m,
  mergeTailRefresh,
  prependOlderOhlcv,
  rateLimitRetryAfterMs,
  resolveAltTokenMintForSolPool,
} from "@bot/data/geckoTerminalOhlcv.js";
import type { Ohlcv } from "@bot/strategy/candleSemantics.js";
import type { BarIndicators } from "@bot/strategy/barIndicators.js";
import { STAGE8_EDUCATIONAL_FOOTER } from "@bot/scope/stage8.js";
import { type StrategyConfig } from "@bot/strategy/strategyConfig.js";
import type { StrategyEvent } from "@bot/strategy/types.js";
import {
  chartToastBuySignalDone,
  chartToastError,
  chartToastInfo,
  chartToastSellSignalDone,
  chartToastStrategyTail,
  mountChartToaster,
} from "./chartToaster.js";
import { notifyDesktop, requestNotifyPermission } from "./notify.js";
import { DEFAULT_DEMO_PAIR_LABEL, DEFAULT_DEMO_POOL_ADDRESS } from "./defaults.js";
import { loadLastPoolAddress, saveLastPoolAddress } from "./lastPoolAddress.js";
import {
  downloadPositionsTxt,
  clearAllPositions,
  loadLocalPositions,
  positionRowKey,
  removePositionByKey,
  syncPositionsFromServer,
  type PositionSignalRow,
} from "./positionsLog.js";
import { runFirstVisitIntro } from "./firstVisitIntro.js";
import { createAutoSwapExecutionAdapter } from "./signalAutoExecution.js";
import { getSessionTradingKeypair, initDeskTradingKeyFromEnv } from "./sessionTradingKey.js";
import {
  applyVwmaPeriodInputs,
  buildDeskStrategyConfig,
  envDefaultVwmaPeriods,
  parseVwmaPeriodInputs,
  saveVwmaPeriods,
} from "./deskVwmaConfig.js";
import { setSignalAutoSolInputToEnvDefaults } from "./signalTradeAmount.js";
import { setSessionPoolSwapTokenMint } from "./sessionPoolSwapMint.js";
import {
  clearInMemoryOpenPositions,
  openPositionPoolCount,
  rehydrateOpenPositionFromLog,
  resetTradePairingTracking,
} from "./sessionTradePairing.js";
import { readDeskEnv } from "./chartWebEnv.js";
import { mountWalletBalanceChart, tradeBalanceEvents } from "./walletBalanceChart.js";

/** Icon-only control for removing a row from the signal log (label via `aria-label` on the button). */
const TRASH_SVG = `<svg class="position-row-delete__icon" xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" focusable="false" aria-hidden="true"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>`;

const POSITIONS_PAGE_SIZE = 15;

/** Recent bars considered for ENTRY/EXIT hooks + toasts (TWO_GREEN entry often completes on lastIdx-1). */
const EXEC_SIGNAL_TAIL_LOOKBACK = 3;
const MAX_DELIVERED_SIGNAL_KEYS = 400;

type MetricsRow = Pick<BarIndicators, "vwap" | "vwma3" | "vwma9" | "vwma18">;

/** Last painted view series — used for the bar OHLC line and crosshair. */
let chartViewBars: Ohlcv[] = [];
let chartViewIndicators: MetricsRow[] = [];

function $(sel: string): HTMLElement {
  const el = document.querySelector(sel);
  if (!el || !(el instanceof HTMLElement)) {
    throw new Error(`Missing element: ${sel}`);
  }
  return el;
}

function fmt(n: number | undefined): string {
  if (n === undefined || !Number.isFinite(n)) {
    return "—";
  }
  const abs = Math.abs(n);
  if (abs >= 1_000_000) {
    return `${(n / 1_000_000).toFixed(3)}M`;
  }
  if (abs >= 1_000) {
    return `${(n / 1_000).toFixed(3)}K`;
  }
  return n.toFixed(4);
}

/** OHLC in the bar HUD line — 5 dp to match the main price scale. */
function fmtHudOhlc(n: number): string {
  if (!Number.isFinite(n)) {
    return "—";
  }
  return n.toFixed(5);
}

function barHudLine(b: Ohlcv): string {
  return `${new Date(b.timeMs).toISOString()} · O ${fmtHudOhlc(b.open)} · H ${fmtHudOhlc(b.high)} · L ${fmtHudOhlc(b.low)} · C ${fmtHudOhlc(b.close)}`;
}

function toCandles(bars: readonly Ohlcv[]): CandlestickData[] {
  return bars.map((b) => ({
    time: Math.floor(b.timeMs / 1000) as UTCTimestamp,
    open: b.open,
    high: b.high,
    low: b.low,
    close: b.close,
  }));
}

function toLine(bars: readonly Ohlcv[], values: readonly number[]): LineData[] {
  const out: LineData[] = [];
  for (let i = 0; i < bars.length; i++) {
    const v = values[i];
    if (!Number.isFinite(v)) {
      continue;
    }
    const b = bars[i];
    if (!b) {
      continue;
    }
    out.push({ time: Math.floor(b.timeMs / 1000) as UTCTimestamp, value: v as number });
  }
  return out;
}

function toVolume(bars: readonly Ohlcv[]): HistogramData[] {
  return bars.map((b) => ({
    time: Math.floor(b.timeMs / 1000) as UTCTimestamp,
    value: b.volume,
    color: b.close >= b.open ? "rgba(38,166,154,0.55)" : "rgba(239,83,80,0.55)",
  }));
}

/**
 * BUY/SELL flags on the candle series. Deliberately NOT the same muted teal/red used for
 * candle up/down (those blend into the candle body colors around them) — bright, saturated
 * "signal" colors that don't collide with any VWAP/VWMA line or candle color already on the
 * chart, so they read as unmistakably distinct from routine bullish/bearish candles.
 */
const BUY_SIGNAL_COLOR = "#00d68f";
const SELL_SIGNAL_COLOR = "#ff3b5c";

function toSignalMarkers(bars: readonly Ohlcv[], events: readonly StrategyEvent[]): SeriesMarker<UTCTimestamp>[] {
  const out: SeriesMarker<UTCTimestamp>[] = [];
  for (const ev of events) {
    if (ev.kind !== "SIGNAL_ENTRY" && ev.kind !== "SIGNAL_EXIT") {
      continue;
    }
    const b = bars[ev.barIndex];
    if (!b) {
      continue;
    }
    const time = Math.floor(b.timeMs / 1000) as UTCTimestamp;
    out.push(
      ev.kind === "SIGNAL_ENTRY"
        ? { time, position: "belowBar", color: BUY_SIGNAL_COLOR, shape: "arrowUp", text: "BUY", size: 2 }
        : { time, position: "aboveBar", color: SELL_SIGNAL_COLOR, shape: "arrowDown", text: "SELL", size: 2 },
    );
  }
  out.sort((a, b) => (a.time as number) - (b.time as number));
  return out;
}

/**
 * Keeps pan/zoom inside valid bar indices after `setData` changes length.
 * `rightPadBars` extends the max logical index past the last data bar (whitespace) to match
 * {@link CHART_TIME_SCALE_RIGHT_OFFSET_BARS} so padding is not stripped on refresh.
 */
function clampLogicalRangeToBarCount(
  range: LogicalRange,
  barCount: number,
  rightPadBars = 0,
): LogicalRange {
  if (barCount < 1) {
    return { from: 0 as Logical, to: 0 as Logical };
  }
  const max = barCount - 1 + rightPadBars;
  let from = range.from as number;
  let to = range.to as number;
  if (from > to) {
    const t = from;
    from = to;
    to = t;
  }
  const span = Math.max(0.5, to - from);
  from = Math.max(0, from);
  to = Math.min(max, to);
  if (to <= from) {
    to = Math.min(max, from + span);
  }
  return { from: from as Logical, to: to as Logical };
}

/** Default 1m window width on first load / explicit reload (~2h). */
const DEFAULT_VISIBLE_1M_BARS = 120;
/**
 * Whitespace to the right of the last bar so price-scale last-value labels (~5dp wide) do not cover the latest
 * candle, including on narrow viewports.
 */
/** Wider strip = last candles sit clearly left of VWAP/VWMA tags (like a vertical “margin” before the scale). */
const CHART_TIME_SCALE_RIGHT_OFFSET_BARS = 36;
/** When the left edge of the visible logical range is within this many bars of index 0, fetch older OHLCV. */
const HISTORY_PREFETCH_FROM_EDGE = 28;
/**
 * Page size for older OHLCV pages (`before_timestamp` window).
 * Kept small to avoid triggering the GeckoTerminal public rate limit when scrolling history.
 */
const HISTORY_PAGE_LIMIT = 100;

/** Parse a Vite-injected string env to a positive integer, falling back when absent/invalid. */
function toPositiveInt(raw: string | undefined, fallback: number): number {
  const n = Number((raw ?? "").trim());
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

/**
 * Candles and volume only exist on bar indices 0..lastIdx; the time scale can extend
 * `to` past the last index so the plot has empty "bars" to the right — that zone does not
 * draw candles, only the grid and the price scale (VWAP / VWMA last-value tags).
 * `setVisibleRange` on silent refresh can remove that space; re-assert logical padding.
 */
function ensureTimeScaleRightWhitespacePad(chart: IChartApi, barCount: number): void {
  if (barCount < 1) {
    return;
  }
  const pad = CHART_TIME_SCALE_RIGHT_OFFSET_BARS;
  const lastIdx = barCount - 1;
  const needTo = lastIdx + pad;
  const lr = chart.timeScale().getVisibleLogicalRange();
  if (lr === null) {
    return;
  }
  const from = lr.from as number;
  const to = lr.to as number;
  if (to < lastIdx - 0.5) {
    return;
  }
  if (to >= needTo - 0.01) {
    return;
  }
  chart.timeScale().setVisibleLogicalRange({ from: from as Logical, to: needTo as Logical });
}

/** After OHLCV refresh: first paint shows the latest ~2h of 1m bars; silent poll restores prior time/price window. */
function applyTimeScaleAfterData(
  chart: IChartApi,
  silent: boolean,
  barCount: number,
  prevTime: Range<Time> | null,
  prevLogical: LogicalRange | null,
): void {
  if (!silent) {
    if (barCount < 1) {
      return;
    }
    const vis = Math.min(DEFAULT_VISIBLE_1M_BARS, barCount);
    const pad = CHART_TIME_SCALE_RIGHT_OFFSET_BARS;
    chart.timeScale().setVisibleLogicalRange({
      from: (barCount - vis) as Logical,
      to: (barCount - 1 + pad) as Logical,
    });
    ensureTimeScaleRightWhitespacePad(chart, barCount);
    return;
  }
  if (prevTime !== null) {
    try {
      chart.timeScale().setVisibleRange(prevTime);
      ensureTimeScaleRightWhitespacePad(chart, barCount);
      return;
    } catch {
      // fall through — e.g. range no longer overlaps new series
    }
  }
  if (prevLogical !== null && barCount > 0) {
    try {
      chart.timeScale().setVisibleLogicalRange(
        clampLogicalRangeToBarCount(prevLogical, barCount, CHART_TIME_SCALE_RIGHT_OFFSET_BARS),
      );
      ensureTimeScaleRightWhitespacePad(chart, barCount);
      return;
    } catch {
      // fall through
    }
  }
  if (barCount > 0) {
    chart.timeScale().fitContent();
    ensureTimeScaleRightWhitespacePad(chart, barCount);
  } else {
    chart.timeScale().fitContent();
  }
}

function rememberSignalKey(delivered: Set<string>, key: string): boolean {
  if (delivered.has(key)) {
    return false;
  }
  delivered.add(key);
  while (delivered.size > MAX_DELIVERED_SIGNAL_KEYS) {
    const first = delivered.values().next().value as string | undefined;
    if (first === undefined) {
      break;
    }
    delivered.delete(first);
  }
  return true;
}

function tailWindowEvents(events: readonly StrategyEvent[], lastIndex: number, lookback: number): StrategyEvent[] {
  const span = Math.max(1, lookback);
  const minIdx = Math.max(0, lastIndex - (span - 1));
  return events.filter((e) => e.barIndex >= minIdx && e.barIndex <= lastIndex);
}

/** Short `abcd1234…wxyz5678` form for tight spaces (sidebar card); full address stays in `title`. */
function shortenAddress(addr: string): string {
  return addr.length <= 16 ? addr : `${addr.slice(0, 8)}…${addr.slice(-8)}`;
}

function wireDeskWalletAddressBanner(onBalance?: (lamports: number) => void): void {
  const el = document.getElementById("desk-wallet-address");
  const sidebarAddrEl = document.getElementById("wallet-balance-address");
  // Bumped on every refresh so a slow RPC response for a since-replaced wallet can't clobber
  // the balance shown for the current one.
  let requestSeq = 0;
  const refresh = (): void => {
    requestSeq += 1;
    const seq = requestSeq;
    const kp = getSessionTradingKeypair();
    if (kp === null) {
      if (el) {
        el.hidden = true;
        el.replaceChildren();
        el.removeAttribute("title");
      }
      if (sidebarAddrEl) {
        sidebarAddrEl.hidden = true;
        sidebarAddrEl.textContent = "";
        sidebarAddrEl.removeAttribute("title");
      }
      return;
    }
    const addr = kp.publicKey.toBase58();

    let balanceLine: HTMLSpanElement | null = null;
    if (el) {
      const addrLine = document.createElement("span");
      addrLine.textContent = `Desk wallet: ${addr}`;
      balanceLine = document.createElement("span");
      balanceLine.className = "desk-wallet-banner__balance";
      balanceLine.textContent = "Balance: loading…";
      el.hidden = false;
      el.title = addr;
      el.replaceChildren(addrLine, document.createElement("br"), balanceLine);
    }
    if (sidebarAddrEl) {
      sidebarAddrEl.hidden = false;
      sidebarAddrEl.textContent = shortenAddress(addr);
      sidebarAddrEl.title = addr;
    }

    void (async () => {
      try {
        const conn = new Connection(readDeskEnv().rpcUrl, { commitment: "confirmed" });
        const lamports = await conn.getBalance(kp.publicKey);
        if (seq !== requestSeq) {
          return;
        }
        if (balanceLine) {
          balanceLine.textContent = `Balance: ${(lamports / LAMPORTS_PER_SOL).toFixed(4)} SOL`;
        }
        onBalance?.(lamports);
      } catch (e) {
        if (seq !== requestSeq) {
          return;
        }
        if (balanceLine) {
          balanceLine.textContent = "Balance: unavailable (RPC error)";
          balanceLine.title = e instanceof Error ? e.message : String(e);
        }
      }
    })();
  };
  refresh();
  window.addEventListener("chart-web:desk-wallet-changed", refresh);
}

async function mount(): Promise<void> {
  mountChartToaster();
  const keyInit = initDeskTradingKeyFromEnv();
  if (!keyInit.ok) {
    chartToastError(
      "Desk private key",
      `Automatic signal swaps are disabled: ${keyInit.error} Set VITE_DESK_PRIVATE_KEY in the environment used to start Vite (e.g. apps/chart-web/.env, or deploy/chart-web-pm2-env/chart-web-N.env via PM2). After changing it, restart the dev server (PM2: pm2 restart chart-web-N --update-env). Use a hot wallet only — Vite exposes VITE_* to the client bundle.`,
    );
  }
  const params = new URLSearchParams(window.location.search);
  const fromUrl = params.get("pool")?.trim();
  const rememberedPool = loadLastPoolAddress();
  // Priority: an explicit ?pool= link always wins (for sharing a specific pool); otherwise
  // restore whatever pool last actually loaded in this browser; only fall back to the demo
  // pool on a genuinely first-ever visit with nothing remembered.
  const initialPool = fromUrl && fromUrl.length > 0 ? fromUrl : (rememberedPool ?? DEFAULT_DEMO_POOL_ADDRESS);

  const app = $("#app");
  app.innerHTML = `
      <header class="app-header" role="banner">
        <div class="app-header__top">
          <div class="app-header__brand-row">
            <div class="app-brand" aria-label="sol_bot trading desk">
              <div class="app-brand__marks">
                <img src="/branding/solana.svg" width="26" height="26" alt="" />
                <img src="/branding/usdc.svg" width="26" height="26" alt="" />
              </div>
              <div class="app-brand__text">
                <span class="app-brand__name">Solana Trading Bot</span>
                <span class="app-brand__tag">Solana · chart desk</span>
              </div>
            </div>
            <nav class="desk-nav" aria-label="Section shortcuts">
              <a class="desk-nav__link" href="#desk-hero">Chart</a>
              <a class="desk-nav__link" href="#select-pa">Select PA</a>
              <a class="desk-nav__link" href="#signal-log">Signals</a>
            </nav>
          </div>
          <div class="app-header__toolbar-row">
            <div class="toolbar" role="search">
              <input id="pool" type="text" spellcheck="false" autocomplete="off"
                placeholder="Pool / pair address (DexScreener)" />
              <div class="toolbar-actions">
                <button id="btn-load" class="primary btn-pill-glow" type="button">Load pool →</button>
                <button id="btn-notify" class="btn-ghost-pill" type="button">Alerts</button>
                <a href="#signal-log" class="toolbar-link toolbar-link--caps">Log</a>
              </div>
            </div>
          </div>
          <p id="desk-wallet-address" class="desk-wallet-banner hint" hidden aria-live="polite"></p>
        </div>
        <p class="app-header__tagline">VWAP / VWMA signal bot · <span class="sol-gradient-text">1m</span> chart desk</p>
      </header>
      <div id="desk-hero" class="desk-hero">
        <div class="desk-hero__glow" aria-hidden="true"></div>
        <div class="desk-hero__ring" aria-hidden="true"></div>
        <ul class="desk-orbit" aria-hidden="true">
          <li class="orbit-node orbit-node--tr">
            <span class="orbit-node__bubble"><img src="/branding/solana.svg" width="22" height="22" alt="" /></span>
          </li>
          <li class="orbit-node orbit-node--br">
            <span class="orbit-node__bubble"><img src="/branding/jupiter.svg" width="22" height="22" alt="" /></span>
          </li>
          <li class="orbit-node orbit-node--bl">
            <span class="orbit-node__bubble"><img src="/branding/usdc.svg" width="22" height="22" alt="" /></span>
          </li>
          <li class="orbit-node orbit-node--ml">
            <span class="orbit-node__bubble"><img src="/branding/wallet.svg" width="22" height="22" alt="" /></span>
          </li>
        </ul>
        <div class="desk-hero__content glass-deck">
          <p class="hero-eyebrow">
            <span class="hero-badge">Desk live</span>
            <span class="hero-eyebrow__text">1m OHLCV · strategy-linked indicators</span>
          </p>
          <div class="pair-block">
            <div id="pair" class="hero-pair-line"></div>
            <div id="subpair" class="hint hero-subline"></div>
          </div>
          <div class="metrics">
            <div class="metric"><div class="k">VWAP (UTC DAY)</div><div class="v" id="m-vwap">—</div></div>
            <div class="metric"><div class="k" id="metric-label-vwma-fast">VWMA (3)</div><div class="v" id="m-3">—</div></div>
            <div class="metric"><div class="k" id="metric-label-vwma-mid">VWMA (9)</div><div class="v" id="m-9">—</div></div>
            <div class="metric"><div class="k" id="metric-label-vwma-slow">VWMA (18)</div><div class="v" id="m-18">—</div></div>
          </div>
          <div class="signal-auto-sol-row" role="group" aria-label="Auto-signal swap size in SOL">
            <label class="signal-auto-sol-label" for="signal-auto-sol-amount">Auto-signal size (SOL)</label>
            <input
              id="signal-auto-sol-amount"
              class="signal-auto-sol-input"
              type="text"
              inputmode="decimal"
              autocomplete="off"
              spellcheck="false"
            />
            <p class="hint signal-auto-sol-hint">BUY: SOL spent. SELL: SOL received. Cleared = use <code class="env-code">.env</code> defaults.</p>
          </div>
          <div class="vwma-periods-row" role="group" aria-label="VWMA window lengths for strategy">
            <span class="vwma-periods-label">VWMA periods</span>
            <label class="vwma-period-field" for="vwma-fast"><span class="vwma-period-field__k">Fast</span>
              <input id="vwma-fast" class="vwma-period-input" type="number" min="1" max="500" step="1" required />
            </label>
            <label class="vwma-period-field" for="vwma-mid"><span class="vwma-period-field__k">Mid</span>
              <input id="vwma-mid" class="vwma-period-input" type="number" min="1" max="500" step="1" required />
            </label>
            <label class="vwma-period-field" for="vwma-slow"><span class="vwma-period-field__k">Slow</span>
              <input id="vwma-slow" class="vwma-period-input" type="number" min="1" max="500" step="1" required />
            </label>
            <button type="button" id="btn-vwma-apply" class="btn-vwma-apply">Apply indicators</button>
            <p id="vwma-periods-hint" class="hint vwma-periods-hint">Defaults 3 / 9 / 18. Require fast &lt; mid &lt; slow. Stored in this browser.</p>
          </div>
          <div id="crosshair-hud" class="crosshair-hud" aria-live="polite"></div>
          <div id="banner" style="display:none" class="banner"></div>
          <div class="desk-chart-row">
            <div class="chart-wrap">
              <div id="chart-overlay" class="chart-overlay visible">Loading 1m OHLCV…</div>
              <div id="chart"></div>
            </div>
            <div class="wallet-balance-card" aria-label="Wallet balance by trade">
              <div class="wallet-balance-card__head">
                <span class="wallet-balance-card__title">Wallet balance</span>
                <span id="wallet-balance-address" class="wallet-balance-card__address" hidden></span>
                <div class="wallet-balance-card__stat-row">
                  <span id="wallet-balance-current" class="wallet-balance-card__value">—</span>
                  <span id="wallet-balance-delta" class="wallet-balance-card__delta" hidden></span>
                </div>
                <span id="wallet-balance-hint" class="wallet-balance-card__hint">By trade — hover a point for details</span>
              </div>
              <div id="wallet-balance-chart" class="wallet-balance-chart"></div>
              <p id="wallet-balance-hud" class="hint wallet-balance-card__hud"></p>
              <p id="wallet-balance-empty" class="hint wallet-balance-card__empty">No wallet balance yet — set a desk private key to see live history here.</p>
            </div>
          </div>
        </div>
      </div>
      <section id="select-pa" class="select-pa">
        <div class="select-pa__inner glass-deck">
          <h2 class="select-pa-title">Select PA</h2>
          <p class="hint select-pa-hint">
            Paste a Solana token mint (coin address). The desk lists up to <strong>five</strong> ranked chart pools from
            <strong>DexScreener</strong> (then GeckoTerminal), with <strong>Perplexity</strong> as fallback when APIs have
            no pairs yet. Tap a pool to select it, then use it in the chart — always verify on GeckoTerminal.
          </p>
          <div class="select-pa-row">
            <label class="select-pa-label" for="select-pa-mint">Token mint</label>
            <input
              id="select-pa-mint"
              class="select-pa-input"
              type="text"
              spellcheck="false"
              autocomplete="off"
              placeholder="e.g. EPjFWdd5… (base58 mint)"
            />
            <button id="btn-select-pa-suggest" class="primary btn-pill-glow" type="button">Suggest pool</button>
          </div>
          <div class="select-pa-results">
            <pre id="select-pa-out" class="select-pa-out" aria-live="polite"></pre>
            <ol id="select-pa-pool-list" class="select-pa-pool-list" hidden></ol>
          </div>
          <div class="select-pa-actions">
            <button id="btn-select-pa-use" class="btn-ghost-pill" type="button" disabled>Use in chart</button>
            <a class="toolbar-link toolbar-link--caps" href="#desk-hero">Back to chart</a>
          </div>
        </div>
      </section>

      <section id="signal-log" class="signal-log">
        <div class="signal-log-head">
          <h2 class="signal-log-title">Signal history</h2>
          <div class="signal-log-actions">
            <button id="btn-positions-start-new" type="button">Start New</button>
            <button id="btn-positions-refresh" type="button">Sync file</button>
            <button id="btn-positions-export" type="button">Download signal history (.txt)</button>
            <button id="btn-positions-clear" type="button" class="btn-danger-outline">Clear</button>
          </div>
        </div>
        <p class="hint signal-log-hint">Sorted by most recently updated (falls back to created, then signal time), <b>15 rows per page</b>. <b>Trade ID</b> is unique per BUY; the matching SELL reuses that id. <b>Tx</b> shows on-chain outcome (success / error / skipped). <b>Start New</b> resets open-position tracking to flat without deleting any history — use it if a pool's tracking looks stuck and you've confirmed the wallet is actually empty of it. <b>Clear</b> permanently deletes every row (confirmation required) — same action as the trash icon below. <code>npm run chart:dev</code> syncs to <code>positions-&lt;port&gt;.txt</code> under <code>apps/chart-web/</code> (same port as <code>CHART_WEB_PORT</code>; one file per PM2 process); otherwise <b>Download</b> saves the list.</p>
        <div class="table-scroll">
          <table class="positions-table" aria-label="Historical BUY and SELL signals">
            <thead>
              <tr>
                <th>Trade ID</th>
                <th>Time (UTC)</th>
                <th>Created (UTC)</th>
                <th>Updated (UTC)</th>
                <th>Side</th>
                <th>Pair</th>
                <th>Pool</th>
                <th>Bar</th>
                <th>Reason</th>
                <th>Tx</th>
                <th>Tx detail</th>
                <th class="positions-table__th-actions" scope="col">
                  <div class="positions-actions-head">
                    <span class="positions-actions-head__label">Actions</span>
                    <button
                      type="button"
                      id="btn-positions-clear-all"
                      class="position-icon-btn position-clear-all"
                      title="Delete all rows"
                      aria-label="Delete all signal history rows"
                    >
                      ${TRASH_SVG}
                    </button>
                  </div>
                </th>
              </tr>
            </thead>
            <tbody id="positions-tbody"></tbody>
          </table>
        </div>
        <div class="positions-pagination" id="positions-pagination" role="navigation" aria-label="Signal history pages">
          <button type="button" id="btn-positions-prev" class="positions-page-btn" title="Page with more recent signals">Previous</button>
          <p class="positions-page-status" id="positions-page-status" aria-live="polite"></p>
          <button type="button" id="btn-positions-next" class="positions-page-btn" title="Page with older signals">Next</button>
        </div>
      </section>
      <footer class="stage8-footer" role="note">${STAGE8_EDUCATIONAL_FOOTER}</footer>
  `;

  const walletBalanceChart = mountWalletBalanceChart(
    $("#wallet-balance-chart"),
    document.getElementById("wallet-balance-hud"),
  );
  /** Live balance from the wallet banner's own fetch (see {@link wireDeskWalletAddressBanner}) — the
   * headline stat number; independent of the chart, which only plots actual trade fills. */
  let liveWalletBalanceSol: number | null = null;

  const refreshWalletBalanceCard = (): void => {
    const events = tradeBalanceEvents(loadLocalPositions());
    walletBalanceChart.setEvents(events);
    const emptyEl = document.getElementById("wallet-balance-empty");
    const currentEl = document.getElementById("wallet-balance-current");
    const deltaEl = document.getElementById("wallet-balance-delta");
    const chartEl = document.getElementById("wallet-balance-chart");
    const hudEl = document.getElementById("wallet-balance-hud");
    const hintEl = document.getElementById("wallet-balance-hint");

    const lastEvent = events.length > 0 ? events[events.length - 1] : undefined;
    const currentValue = liveWalletBalanceSol ?? lastEvent?.value ?? null;
    if (currentEl) currentEl.textContent = currentValue === null ? "—" : `${currentValue.toFixed(4)} SOL`;

    if (events.length === 0) {
      if (chartEl) chartEl.hidden = true;
      if (hudEl) hudEl.hidden = true;
      if (deltaEl) deltaEl.hidden = true;
      if (emptyEl) {
        emptyEl.hidden = false;
        emptyEl.textContent =
          currentValue === null
            ? "No wallet balance yet — set a desk private key to see live history here."
            : "No trades yet — the chart fills in after the first BUY or SELL.";
      }
      if (hintEl) hintEl.textContent = "By trade — hover a point for details";
      return;
    }

    if (emptyEl) emptyEl.hidden = true;
    if (chartEl) chartEl.hidden = false;
    if (hudEl) hudEl.hidden = false;
    if (hintEl) hintEl.textContent = `${events.length} fill${events.length === 1 ? "" : "s"} — hover a point for details`;
    if (deltaEl) {
      const firstValue = events[0]!.value;
      const diff = currentValue === null ? null : currentValue - firstValue;
      if (diff !== null && Math.abs(diff) >= 0.0001) {
        deltaEl.hidden = false;
        deltaEl.textContent = `${diff > 0 ? "+" : ""}${diff.toFixed(4)} SOL`;
        deltaEl.className = `wallet-balance-card__delta ${diff >= 0 ? "is-up" : "is-down"}`;
      } else {
        deltaEl.hidden = true;
      }
    }
  };

  wireDeskWalletAddressBanner((lamports) => {
    liveWalletBalanceSol = lamports / LAMPORTS_PER_SOL;
    refreshWalletBalanceCard();
  });
  refreshWalletBalanceCard();

  let deskStrategy: StrategyConfig = buildDeskStrategyConfig();
  applyVwmaPeriodInputs(
    $("#vwma-fast") as HTMLInputElement,
    $("#vwma-mid") as HTMLInputElement,
    $("#vwma-slow") as HTMLInputElement,
  );
  const vwmaPeriodsHintEl = document.getElementById("vwma-periods-hint");
  if (vwmaPeriodsHintEl) {
    const envDefault = envDefaultVwmaPeriods();
    vwmaPeriodsHintEl.textContent = `Defaults ${envDefault.fast} / ${envDefault.mid} / ${envDefault.slow}. Require fast < mid < slow. Stored in this browser.`;
  }

  runFirstVisitIntro();

  /** 0-based; page 0 = newest 15. Clamped in {@link renderPositionsTableBody}. */
  let positionsPageIndex = 0;

  /** updatedAt if set, else createdAt, else `ts` — rows logged before these fields existed still sort sensibly. */
  const positionSortKey = (r: PositionSignalRow): string => r.updatedAt || r.createdAt || r.ts;

  const renderPositionsTableBody = (): void => {
    const tbody = document.getElementById("positions-tbody");
    if (!tbody) {
      return;
    }
    tbody.replaceChildren();
    const allRows = loadLocalPositions().sort((a, b) => positionSortKey(b).localeCompare(positionSortKey(a)));
    const n = allRows.length;
    const totalPages = n === 0 ? 1 : Math.ceil(n / POSITIONS_PAGE_SIZE);
    positionsPageIndex = Math.max(0, Math.min(positionsPageIndex, totalPages - 1));
    const start = positionsPageIndex * POSITIONS_PAGE_SIZE;
    const pageRows = allRows.slice(start, start + POSITIONS_PAGE_SIZE);

    const pageStatus = document.getElementById("positions-page-status");
    if (pageStatus) {
      const from = n === 0 ? 0 : start + 1;
      const to = n === 0 ? 0 : start + pageRows.length;
      pageStatus.textContent =
        n === 0
          ? "Page 1 of 1 · 0 records"
          : `Page ${positionsPageIndex + 1} of ${totalPages} · ${from}–${to} of ${n}`;
    }
    const prevBtn = document.getElementById("btn-positions-prev");
    if (prevBtn instanceof HTMLButtonElement) {
      prevBtn.disabled = positionsPageIndex <= 0;
    }
    const nextBtn = document.getElementById("btn-positions-next");
    if (nextBtn instanceof HTMLButtonElement) {
      nextBtn.disabled = positionsPageIndex >= totalPages - 1;
    }

    for (const r of pageRows) {
      const tr = document.createElement("tr");
      const tdId = document.createElement("td");
      tdId.className = "trade-id-cell";
      if (r.tradeId && r.tradeId.length > 0) {
        const id = r.tradeId;
        tdId.textContent = id.length > 12 ? `${id.slice(0, 8)}…` : id;
        tdId.title = id;
        tdId.setAttribute("data-full-trade-id", id);
      } else {
        tdId.textContent = "—";
        tdId.classList.add("tx-missing");
      }
      const tdTs = document.createElement("td");
      tdTs.className = "time-cell";
      tdTs.textContent = r.ts;
      const tdCreatedAt = document.createElement("td");
      tdCreatedAt.className = "time-cell";
      tdCreatedAt.textContent = r.createdAt ?? "—";
      if (!r.createdAt) {
        tdCreatedAt.classList.add("tx-missing");
      }
      const tdUpdatedAt = document.createElement("td");
      tdUpdatedAt.className = "time-cell";
      tdUpdatedAt.textContent = r.updatedAt ?? "—";
      if (!r.updatedAt) {
        tdUpdatedAt.classList.add("tx-missing");
      }
      const tdSide = document.createElement("td");
      tdSide.textContent = r.side;
      // An errored fill is not "a sell that happened" or "a buy that happened" — the direction
      // color (green/red, already reused by the Tx column's ok/err badge) would misleadingly
      // read as a completed trade. Warning-colored side text flags it as needing attention instead.
      tdSide.className = r.txStatus === "error" ? "side-warn" : r.side === "BUY" ? "side-buy" : "side-sell";
      const tdPair = document.createElement("td");
      tdPair.className = "pair-cell";
      tdPair.textContent = r.pair;
      const tdPool = document.createElement("td");
      tdPool.textContent = r.pool;
      tdPool.className = "mono pool-cell";
      tdPool.title = r.pool;
      const tdBar = document.createElement("td");
      tdBar.className = "bar-cell";
      tdBar.textContent = String(r.barIndex);
      const tdReason = document.createElement("td");
      tdReason.textContent = r.reason;
      tdReason.className = "reason-cell";
      tdReason.title = r.reason;
      const tdTx = document.createElement("td");
      if (r.txStatus === "ok") {
        tdTx.textContent = "Success";
        tdTx.className = "tx-cell tx-ok";
      } else if (r.txStatus === "error") {
        tdTx.textContent = "Error";
        tdTx.className = "tx-cell tx-err";
      } else if (r.txStatus === "skipped") {
        tdTx.textContent = "Skipped";
        tdTx.className = "tx-cell tx-skip";
      } else {
        tdTx.textContent = "—";
        tdTx.className = "tx-cell tx-missing";
      }
      const tdTxDetail = document.createElement("td");
      tdTxDetail.className = "tx-detail-cell";
      if (r.signature && r.signature.length > 0) {
        const a = document.createElement("a");
        a.href = `https://solscan.io/tx/${r.signature}`;
        a.target = "_blank";
        a.rel = "noopener noreferrer";
        a.className = "tx-detail-link";
        a.textContent = "Solscan →";
        tdTxDetail.appendChild(a);
      }
      if (r.txDetail) {
        const line = document.createElement("div");
        line.className = "tx-detail-text";
        line.textContent = r.txDetail;
        tdTxDetail.appendChild(line);
      }
      if (tdTxDetail.childNodes.length === 0) {
        tdTxDetail.textContent = "—";
      }
      const tdActions = document.createElement("td");
      tdActions.className = "positions-table__cell-actions";
      const delBtn = document.createElement("button");
      delBtn.type = "button";
      delBtn.className = "position-icon-btn position-row-delete";
      delBtn.innerHTML = TRASH_SVG;
      const rowKey = positionRowKey(r);
      delBtn.setAttribute("data-position-key", encodeURIComponent(rowKey));
      delBtn.setAttribute("aria-label", "Delete this signal row");
      delBtn.title = "Delete row";
      delBtn.addEventListener("click", () => {
        if (!window.confirm("Delete this signal from history?")) {
          return;
        }
        const key = decodeURIComponent(delBtn.getAttribute("data-position-key") ?? "");
        if (key.length === 0) {
          return;
        }
        void removePositionByKey(key).then(() => onPositionsChanged());
      });
      tdActions.appendChild(delBtn);
      tr.append(tdId, tdTs, tdCreatedAt, tdUpdatedAt, tdSide, tdPair, tdPool, tdBar, tdReason, tdTx, tdTxDetail, tdActions);
      tbody.appendChild(tr);
    }
    const clearAllBtn = document.getElementById("btn-positions-clear-all");
    if (clearAllBtn instanceof HTMLButtonElement) {
      clearAllBtn.disabled = n === 0;
    }
    const clearBtn = document.getElementById("btn-positions-clear");
    if (clearBtn instanceof HTMLButtonElement) {
      clearBtn.disabled = n === 0;
    }
  };

  /** Positions table + wallet-balance chart both read from the same log — refresh together whenever it changes. */
  const onPositionsChanged = (): void => {
    renderPositionsTableBody();
    refreshWalletBalanceCard();
  };

  /** Dedupe ARMED/INVALIDATED toasts across 60s polls (FSM replay repeats the same events). */
  const deliveredSignals = new Set<string>();
  /** Shared across ticks so the same ENTRY/EXIT bar does not swap twice. */
  const autoSwapDedupe = new Set<string>();

  const poolInput = $("#pool") as HTMLInputElement;
  poolInput.value = initialPool;
  setSignalAutoSolInputToEnvDefaults();

  const btnLoad = $("#btn-load") as HTMLButtonElement;
  const btnNotify = $("#btn-notify") as HTMLButtonElement;
  const banner = $("#banner");
  const pair = $("#pair");
  const subpair = $("#subpair");

  /** After first successful OHLCV paint, interval refreshes run silently (no full-screen loading flash). */
  let chartPrimed = false;

  if (!fromUrl && !rememberedPool) {
    // Genuinely first-ever visit in this browser — nothing in the URL, nothing remembered yet.
    pair.textContent = `${DEFAULT_DEMO_PAIR_LABEL} · 1m · pool ${initialPool}`;
    subpair.textContent = "Demo pool — replace the address above for your pair.";
  } else {
    pair.textContent = `…/… · 1m · pool ${initialPool}`;
    subpair.textContent = fromUrl ? "Loading pair metadata…" : "Restored your last pool — loading…";
  }
  const chartEl = $("#chart");
  const chartOverlay = $("#chart-overlay");

  /** Merged OHLCV for the active pool (rolling tail + optional older pages from `before_timestamp`). */
  let sessionBars: Ohlcv[] = [];
  let sessionMergePool = "";
  let historyExhausted = false;
  let historyBusy = false;
  let lastPairLabel = DEFAULT_DEMO_PAIR_LABEL;

  // In Vite dev the `/gt-api` proxy (vite.config.ts) forwards to api.geckoterminal.com with IPv4-preferring agent.
  // In production the browser hits GeckoTerminal directly (public API, no key needed).
  const apiBase = import.meta.env.DEV
    ? `${window.location.origin}/gt-api`
    : "https://api.geckoterminal.com/api/v2";
  /**
   * maxAttempts = 1: never retry within a single tick so a 429 from one agent doesn't
   * immediately fire more requests.  The 60-second poll interval is the natural retry boundary.
   */
  const ohlcvFetchAttempts = 1;
  const ohlcvFetchTimeoutMs = 30_000;

  /**
   * 429 cooldown: after a rate-limit response, silent poll ticks are suppressed for this window.
   * The Load button always bypasses the cooldown so the user can manually retry.
   */
  let rateLimitedUntilMs = 0;

  // ── GeckoTerminal public rate-limit budget ──────────────────────────────────────────────────
  // The public API is ~10–30 req/min per IP, shared across ALL chart instances on this machine.
  // A FIXED 60s poll window scales total request rate linearly with fleet size: fine at 7
  // instances (7 req/min), but at 10 that's exactly the documented floor with zero margin for a
  // manual Load press, a reconnect burst, or the real limit being stricter than advertised — the
  // fleet would sit right on the edge of 429s instead of safely under it.
  //
  // Instead, each instance's OWN poll interval stretches as the fleet grows so the FLEET-WIDE
  // steady-state rate stays fixed at TARGET_TOTAL_REQ_PER_MIN regardless of N: at N=7 the window
  // is still ~60s (unchanged); at N=10 it's ~75s; it keeps scaling for any future fleet size
  // instead of quietly going over budget. Within that window, instance #i still fires at offset
  // i·(window/N), so the request stream stays evenly spread, never bursty. The same per-instance
  // offset is reused for reconnect retries and post-429 resumes so those never collapse every
  // instance onto the same instant.
  const BASE_POLL_WINDOW_MS = 60_000;
  // Conservative fleet-wide ceiling — well under the documented 10–30 req/min floor, leaving real
  // headroom for manual Load presses, reconnects, history-scroll prefetches (see loadOlderChunk,
  // which is NOT part of this budget — it's event-driven, not scheduled), and the real limit being
  // stricter in practice than advertised (still 429'd at the old target of 8 with a 10-instance fleet).
  const TARGET_TOTAL_REQ_PER_MIN = 5;
  // Sanity backstop only (guards a config typo, e.g. instance count set to 500 by mistake) — the
  // self-scaling window above is what actually keeps any realistic fleet size under budget, so
  // this is set far past any real fleet rather than silently going dark past 8 like before.
  const MAX_AUTOPOLL_AGENTS = 60;

  const basePort = toPositiveInt(import.meta.env.VITE_CHART_WEB_BASE_PORT, 5713);
  const instanceCount = toPositiveInt(import.meta.env.VITE_CHART_WEB_INSTANCE_COUNT, 5);
  const chartPort = toPositiveInt(import.meta.env.VITE_SIGNAL_HISTORY_ID, basePort);
  const agentIdx = Math.max(0, chartPort - basePort);
  const activeAgents = Math.max(1, Math.min(instanceCount, MAX_AUTOPOLL_AGENTS));
  const POLL_WINDOW_MS = Math.max(
    BASE_POLL_WINDOW_MS,
    Math.ceil((BASE_POLL_WINDOW_MS * activeAgents) / TARGET_TOTAL_REQ_PER_MIN),
  );
  // Even spacing keeps the per-IP request stream smooth (e.g. 10 instances, ~75s window → one poll every ~7.5 s).
  const pollSpacingMs = Math.floor(POLL_WINDOW_MS / activeAgents);
  const agentOffsetMs = (agentIdx % activeAgents) * pollSpacingMs;

  /**
   * How long to suppress auto-polls after a 429: honor the server's Retry-After when present, else
   * one full poll window (already sized for the current fleet) plus a small buffer — then add this
   * instance's offset so resumes re-disperse instead of every instance retrying on the same instant.
   */
  const rateLimitCooldownMs = (e: unknown): number => {
    const retryAfter = rateLimitRetryAfterMs(e) ?? 0;
    return Math.max(POLL_WINDOW_MS + 5_000, retryAfter) + agentOffsetMs;
  };

  let busy = false;

  /** 5 dp on the main price scale (e.g. 0.04430) so VWAP / VWMA last-value labels stay distinct. */
  const deskPriceFormat5 = { type: "price" as const, precision: 5, minMove: 0.000_01 };

  const chart: IChartApi = createChart(chartEl, {
    width: chartEl.clientWidth,
    height: 520,
    layout: {
      background: { type: ColorType.Solid, color: "#080b12" },
      textColor: "#a8b0bf",
    },
    grid: {
      vertLines: { color: "rgba(120,132,160,0.12)" },
      horzLines: { color: "rgba(120,132,160,0.12)" },
    },
    crosshair: { mode: CrosshairMode.Normal },
    rightPriceScale: { borderColor: "rgba(120,132,160,0.2)" },
    timeScale: {
      borderColor: "rgba(120,132,160,0.2)",
      timeVisible: true,
      secondsVisible: false,
      rightOffset: CHART_TIME_SCALE_RIGHT_OFFSET_BARS,
      fixLeftEdge: false,
      fixRightEdge: true,
    },
  });

  const candles = chart.addCandlestickSeries({
    upColor: "#26a69a",
    downColor: "#ef5350",
    borderUpColor: "#26a69a",
    borderDownColor: "#ef5350",
    wickUpColor: "#26a69a",
    wickDownColor: "#ef5350",
    priceFormat: deskPriceFormat5,
  });

  const vol = chart.addHistogramSeries({
    priceFormat: { type: "volume" },
    priceScaleId: "",
    color: "rgba(120,123,134,0.35)",
  });
  vol.priceScale().applyOptions({ scaleMargins: { top: 0.85, bottom: 0 } });

  // lastValueVisible/priceLineVisible default to true on every line series, AND a non-empty
  // `title` renders its own on-chart badge independently of lastValueVisible (per lightweight-charts:
  // title "will be displayed on the label next to the last value label" — setting lastValueVisible
  // false alone does NOT remove it). With VWAP + three VWMAs clustered near the current price, their
  // titled badges ("VWMA 3" / "VWMA 9" / "VWMA 18") stack up at the right price-axis edge and widen
  // enough to spill leftward over the most recent real candles, hiding exactly the bars a trader most
  // wants to see. The values are already shown, uncluttered, in the VWAP/VWMA metric cards above the
  // chart, so all three (last-value label, price line, on-chart title badge) are pure redundancy here.
  const deskOverlayLineOptions = { lastValueVisible: false, priceLineVisible: false, title: "" } as const;
  const vwap = chart.addLineSeries({ color: "#e7e9ee", lineWidth: 2, priceFormat: deskPriceFormat5, ...deskOverlayLineOptions });
  const w3 = chart.addLineSeries({ color: "#2962ff", lineWidth: 1, priceFormat: deskPriceFormat5, ...deskOverlayLineOptions });
  const w9 = chart.addLineSeries({ color: "#9945ff", lineWidth: 1, priceFormat: deskPriceFormat5, ...deskOverlayLineOptions });
  const w18 = chart.addLineSeries({ color: "#14f195", lineWidth: 1, priceFormat: deskPriceFormat5, ...deskOverlayLineOptions });

  const syncDeskVwmaPresentation = (p: { fast: number; mid: number; slow: number }): void => {
    const lf = document.getElementById("metric-label-vwma-fast");
    const lm = document.getElementById("metric-label-vwma-mid");
    const ls = document.getElementById("metric-label-vwma-slow");
    if (lf) {
      lf.textContent = `VWMA (${p.fast})`;
    }
    if (lm) {
      lm.textContent = `VWMA (${p.mid})`;
    }
    if (ls) {
      ls.textContent = `VWMA (${p.slow})`;
    }
  };
  syncDeskVwmaPresentation(deskStrategy.vwmaPeriods);

  const updateMetrics = (barIdx: number, indicators: readonly MetricsRow[]) => {
    const row = indicators[barIdx];
    $("#m-vwap").textContent = fmt(row?.vwap);
    $("#m-3").textContent = fmt(row?.vwma3);
    $("#m-9").textContent = fmt(row?.vwma9);
    $("#m-18").textContent = fmt(row?.vwma18);
  };

  const crosshairHudEl = $("#crosshair-hud");

  const setHudToBarIndex = (idx: number): void => {
    if (chartViewIndicators.length === 0 || chartViewBars.length === 0) {
      crosshairHudEl.textContent = "";
      return;
    }
    const clamped = Math.max(0, Math.min(idx, chartViewBars.length - 1));
    updateMetrics(clamped, chartViewIndicators);
    crosshairHudEl.textContent = barHudLine(chartViewBars[clamped]!);
  };

  const setHudToLastBar = (): void => {
    if (chartViewBars.length === 0) {
      crosshairHudEl.textContent = "";
      return;
    }
    setHudToBarIndex(chartViewBars.length - 1);
  };

  const barIndexFromCrosshairParam = (param: {
    time?: Time;
    logical?: Logical;
    point?: { x: number; y: number };
  }): number | null => {
    if (chartViewBars.length === 0) {
      return null;
    }
    const last = chartViewBars.length - 1;
    if (!param.point) {
      return last;
    }
    if (param.logical !== undefined) {
      const li = Math.round(param.logical as number);
      if (li >= 0 && li <= last) {
        return li;
      }
      if (li < 0) {
        return 0;
      }
      return last;
    }
    const t = param.time;
    if (t === undefined) {
      return null;
    }
    if (typeof t !== "number") {
      return null;
    }
    const sec = t;
    const exact = chartViewBars.findIndex((b) => Math.floor(b.timeMs / 1000) === sec);
    if (exact >= 0) {
      return exact;
    }
    return null;
  };

  chart.subscribeCrosshairMove((param) => {
    if (chartViewIndicators.length === 0) {
      return;
    }
    if (!param.point) {
      setHudToLastBar();
      return;
    }
    const idx = barIndexFromCrosshairParam(param);
    if (idx === null) {
      setHudToLastBar();
      return;
    }
    setHudToBarIndex(idx);
  });

  const ro = new ResizeObserver(() => {
    chart.applyOptions({ width: chartEl.clientWidth, height: 520 });
  });
  ro.observe(chartEl);

  let timer: number | undefined;

  const showBanner = (kind: "hidden" | "err" | "info", msg: string) => {
    if (kind === "hidden") {
      banner.style.display = "none";
      banner.textContent = "";
      banner.className = "banner";
      return;
    }
    banner.style.display = "block";
    banner.textContent = msg;
    banner.className = kind === "err" ? "banner err" : "banner info";
  };

  const setChartOverlay = (visible: boolean, text?: string) => {
    chartOverlay.classList.toggle("visible", visible);
    if (text !== undefined) {
      chartOverlay.textContent = text;
    }
  };

  let visibleRangeDebounce: number | undefined;

  const loadOlderChunk = async (): Promise<void> => {
    const pool = poolInput.value.trim();
    if (!pool || historyExhausted || historyBusy || busy || sessionBars.length < 2 || Date.now() < rateLimitedUntilMs) {
      return;
    }
    historyBusy = true;
    const prevLogical = chart.timeScale().getVisibleLogicalRange();
    const beforeLen = sessionBars.length;
    try {
      const oldestSec = Math.floor(sessionBars[0]!.timeMs / 1000);
      const { bars: chunk, meta: olderMeta } = await fetchSolanaPoolOhlcv1m({
        poolAddress: pool,
        limit: HISTORY_PAGE_LIMIT,
        beforeTimestampSec: oldestSec,
        apiBaseUrl: apiBase,
        maxAttempts: ohlcvFetchAttempts,
        fetchTimeoutMs: ohlcvFetchTimeoutMs,
      });
      const altOlder = resolveAltTokenMintForSolPool(olderMeta);
      if (altOlder !== null) {
        setSessionPoolSwapTokenMint(altOlder);
      }
      if (chunk.length === 0) {
        historyExhausted = true;
        return;
      }
      const merged = prependOlderOhlcv(sessionBars, chunk);
      const added = merged.length - beforeLen;
      if (added <= 0) {
        historyExhausted = true;
        return;
      }
      rehydrateOpenPositionFromLog(pool, loadLocalPositions());
      const agent = new SignalAgent({
        strategy: deskStrategy,
        execution: createAutoSwapExecutionAdapter(lastPairLabel, pool, autoSwapDedupe, onPositionsChanged),
        executionHooksScope: "tail_bar_only",
        executionTailBarLookback: EXEC_SIGNAL_TAIL_LOOKBACK,
        log: () => {},
      });
      const res = await agent.runTick(async () => merged);
      if (!res.ok) {
        console.warn("[chart-web] history merge: strategy step failed:", res.error);
        return;
      }
      sessionBars = merged;
      chartViewBars = res.bars;
      chartViewIndicators = res.indicators;

      candles.setData(toCandles(res.bars));
      candles.setMarkers(toSignalMarkers(res.bars, res.strategyEvents));
      vol.setData(toVolume(res.bars));
      vwap.setData(toLine(res.bars, res.indicators.map((i) => i.vwap)));
      w3.setData(toLine(res.bars, res.indicators.map((i) => i.vwma3)));
      w9.setData(toLine(res.bars, res.indicators.map((i) => i.vwma9)));
      w18.setData(toLine(res.bars, res.indicators.map((i) => i.vwma18)));

      if (prevLogical !== null && added > 0) {
        const from = (prevLogical.from as number) + added;
        const to = (prevLogical.to as number) + added;
        chart.timeScale().setVisibleLogicalRange(
          clampLogicalRangeToBarCount(
            { from: from as Logical, to: to as Logical },
            res.bars.length,
            CHART_TIME_SCALE_RIGHT_OFFSET_BARS,
          ),
        );
      } else {
        chart.timeScale().fitContent();
      }
      ensureTimeScaleRightWhitespacePad(chart, res.bars.length);
      const viewLastIdx = res.bars.length - 1;
      if (viewLastIdx >= 0) {
        setHudToBarIndex(viewLastIdx);
      } else {
        crosshairHudEl.textContent = "";
      }
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e);
      if (/429|rate.?limit/i.test(errMsg)) {
        const cooldownMs = rateLimitCooldownMs(e);
        rateLimitedUntilMs = Date.now() + cooldownMs;
        // Same rule as the main poll tick: never surface a 429 — this is a separate code path
        // (history-scroll prefetch, not the scheduled poll) and was missed the first time around,
        // which is exactly how a red "rate limit hit" banner could still show up here.
        console.warn(`[chart-web] GeckoTerminal 429 while loading history — pausing for ~${Math.round(cooldownMs / 1000)} s.`);
      } else {
        console.warn("[chart-web] loading older OHLCV failed:", e);
      }
    } finally {
      historyBusy = false;
    }
  };

  const onVisibleLogicalRangeMaybePrefetch = (range: LogicalRange | null): void => {
    if (range === null || sessionBars.length < 2) {
      return;
    }
    if (historyExhausted || historyBusy || busy) {
      return;
    }
    const from = range.from as number;
    if (from > HISTORY_PREFETCH_FROM_EDGE) {
      return;
    }
    void loadOlderChunk();
  };

  const onVisibleLogicalRangeChanged = (range: LogicalRange | null): void => {
    window.clearTimeout(visibleRangeDebounce);
    visibleRangeDebounce = window.setTimeout(() => onVisibleLogicalRangeMaybePrefetch(range), 480);
  };
  chart.timeScale().subscribeVisibleLogicalRangeChange(onVisibleLogicalRangeChanged);

  async function tick(opts?: { silent?: boolean }): Promise<void> {
    const pool = poolInput.value.trim();
    const silent = opts?.silent === true;
    // During a 429 cooldown, skip automatic poll ticks but allow manual Load presses.
    if (silent && Date.now() < rateLimitedUntilMs) {
      return;
    }
    if (!pool) {
      setSessionPoolSwapTokenMint(null);
      showBanner(
        "info",
        "Paste a Solana AMM pool address (GeckoTerminal pool id) and click Load. Find it on DexScreener → same pool on GeckoTerminal.",
      );
      setChartOverlay(true, "No pool address — paste a pool id above, or reload to restore the demo pool.");
      return;
    }
    if (busy || historyBusy) {
      return;
    }
    busy = true;
    if (!silent) {
      btnLoad.disabled = true;
      showBanner("hidden", "");
      setChartOverlay(true, "Loading 1m OHLCV…");
    }
    try {
      const { bars, meta } = await fetchSolanaPoolOhlcv1m({
        poolAddress: pool,
        limit: 1000,
        apiBaseUrl: apiBase,
        maxAttempts: ohlcvFetchAttempts,
        fetchTimeoutMs: ohlcvFetchTimeoutMs,
      });
      if (bars.length === 0) {
        showBanner(
          "err",
          "No OHLCV rows returned for that pool. Verify the pool id exists on GeckoTerminal (network: solana, timeframe: minute).",
        );
        setChartOverlay(true, "No candles returned for this pool id.");
        return;
      }

      if (pool !== sessionMergePool) {
        sessionMergePool = pool;
        sessionBars = [];
        historyExhausted = false;
        // Remember this pool so a browser refresh restores it instead of falling back to the
        // demo pool. Only reached once bars.length > 0 above, so a typo/invalid pool is never
        // persisted — only a pool that actually returned real candles.
        saveLastPoolAddress(pool);
        // Genuinely switching pools — the previous pool's resolved mint (if any) no longer applies.
        setSessionPoolSwapTokenMint(null);
      }
      sessionBars = mergeTailRefresh(sessionBars, bars);

      const altMint = resolveAltTokenMintForSolPool(meta);
      if (altMint !== null) {
        // Only update on a resolved value — matches loadOlderChunk's existing guard below.
        // GeckoTerminal meta can come back ambiguous/incomplete on a single tick (parseMeta
        // returns {} rather than throwing); unconditionally forwarding that null here would wipe
        // out an already-correctly-resolved mint for the SAME pool, and every balance check that
        // follows (including stale-position reconciliation in signalAutoExecution.ts) would then
        // silently check the wrong token and misfire — a bad tick, not a pool change, must not
        // erase a good value.
        setSessionPoolSwapTokenMint(altMint);
      }

      const label = `${meta.baseSymbol ?? "BASE"}/${meta.quoteSymbol ?? "QUOTE"}`;
      lastPairLabel = label;
      rehydrateOpenPositionFromLog(pool, loadLocalPositions());
      pair.textContent = `${label} · 1m · pool ${pool}`;
      subpair.textContent =
        pool === DEFAULT_DEMO_POOL_ADDRESS
          ? "Demo pool — replace the address above for your pair."
          : `Indicators: VWAP UTC day · VWMA ${deskStrategy.vwmaPeriods.fast}/${deskStrategy.vwmaPeriods.mid}/${deskStrategy.vwmaPeriods.slow} on 1m closes (strategy-linked).`;
      chartPrimed = true;

      const agent = new SignalAgent({
        strategy: deskStrategy,
        execution: createAutoSwapExecutionAdapter(label, pool, autoSwapDedupe, onPositionsChanged),
        executionHooksScope: "tail_bar_only",
        executionTailBarLookback: EXEC_SIGNAL_TAIL_LOOKBACK,
        log: () => {},
      });

      const res = await agent.runTick(async () => sessionBars);
      if (!res.ok) {
        showBanner("err", res.error);
        setChartOverlay(true, "Strategy / indicator step failed. See message above.");
        return;
      }

      const prevTimeRange = silent ? chart.timeScale().getVisibleRange() : null;
      const prevLogicalRange = silent ? chart.timeScale().getVisibleLogicalRange() : null;

      chartViewBars = res.bars;
      chartViewIndicators = res.indicators;

      candles.setData(toCandles(res.bars));
      candles.setMarkers(toSignalMarkers(res.bars, res.strategyEvents));
      vol.setData(toVolume(res.bars));
      vwap.setData(toLine(res.bars, res.indicators.map((i) => i.vwap)));
      w3.setData(toLine(res.bars, res.indicators.map((i) => i.vwma3)));
      w9.setData(toLine(res.bars, res.indicators.map((i) => i.vwma9)));
      w18.setData(toLine(res.bars, res.indicators.map((i) => i.vwma18)));
      applyTimeScaleAfterData(chart, silent, res.bars.length, prevTimeRange, prevLogicalRange);

      const lastIdx = res.bars.length - 1;
      if (lastIdx >= 0) {
        setHudToBarIndex(lastIdx);
      } else {
        crosshairHudEl.textContent = "";
      }
      setChartOverlay(false);

      const tail = tailWindowEvents(res.strategyEvents, lastIdx, EXEC_SIGNAL_TAIL_LOOKBACK);
      for (const ev of tail) {
        if (ev.kind === "SIGNAL_ARMED" || ev.kind === "INVALIDATED") {
          const row = res.bars[ev.barIndex];
          const tMs = row?.timeMs ?? res.bars[lastIdx]!.timeMs;
          const key = `${ev.kind}:${tMs}`;
          if (!rememberSignalKey(deliveredSignals, key)) {
            continue;
          }
          chartToastStrategyTail(label, ev.kind, ev.reason, new Date(tMs).toISOString());
        }
      }
    } catch (e) {
      const msg = describeOhlcvFetchError(e);
      const isRateLimit = /429|rate.?limit/i.test(msg);
      let cooldownSecs = 0;
      if (isRateLimit) {
        const cooldownMs = rateLimitCooldownMs(e);
        cooldownSecs = Math.round(cooldownMs / 1000);
        rateLimitedUntilMs = Date.now() + cooldownMs;
        console.warn(`[chart-web] GeckoTerminal 429 — pausing automatic poll for ~${cooldownSecs} s.`);
      }
      if (isRateLimit) {
        // Never surface a 429 — it's expected under a shared-IP fleet and the cooldown above
        // already handles recovery automatically; a banner here would just be alarming noise for
        // something the user can't (and doesn't need to) do anything about. Console-only.
        showBanner("hidden", "");
        if (chartPrimed) {
          setChartOverlay(false);
        }
        // else: leave whatever overlay is already showing (the default "Loading…" placeholder) —
        // no rate-limit-specific text, so nothing 429-shaped is ever visible on screen.
      } else if (silent && chartPrimed) {
        showBanner("hidden", "");
        console.warn("[chart-web] silent OHLCV refresh failed (will retry on next interval):", e);
        setChartOverlay(false);
      } else {
        showBanner("err", msg);
        setChartOverlay(true, "Could not load OHLCV. See the banner above.");
      }
    } finally {
      busy = false;
      if (!silent) {
        btnLoad.disabled = false;
      }
    }
  }

  btnLoad.addEventListener("click", () => void tick({ silent: false }));

  let lastSuggestedPool = "";
  const selectPaMint = document.getElementById("select-pa-mint");
  const btnSelectPaSuggest = document.getElementById("btn-select-pa-suggest");
  const selectPaOut = document.getElementById("select-pa-out");
  const selectPaPoolList = document.getElementById("select-pa-pool-list");
  const btnSelectPaUse = document.getElementById("btn-select-pa-use");
  if (
    selectPaMint instanceof HTMLInputElement &&
    btnSelectPaSuggest instanceof HTMLButtonElement &&
    selectPaOut instanceof HTMLPreElement &&
    selectPaPoolList instanceof HTMLOListElement &&
    btnSelectPaUse instanceof HTMLButtonElement
  ) {
    btnSelectPaSuggest.addEventListener("click", () => {
      void (async () => {
        const mint = selectPaMint.value.trim();
        selectPaOut.textContent = "";
        selectPaPoolList.innerHTML = "";
        selectPaPoolList.hidden = true;
        lastSuggestedPool = "";
        btnSelectPaUse.disabled = true;
        if (mint.length === 0) {
          selectPaOut.textContent = "Enter a token mint address.";
          return;
        }
        btnSelectPaSuggest.disabled = true;
        selectPaOut.textContent = "Requesting suggestion…";
        try {
          const res = await fetch(`${window.location.origin}/api/suggest-gecko-pool`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ mint }),
          });
          type PoolRow = { rank: number; poolAddress: string; pairHint?: string; notes?: string };
          const data = (await res.json()) as {
            ok?: boolean;
            pools?: PoolRow[];
            poolAddress?: string;
            pairHint?: string;
            notes?: string;
            source?: string;
            error?: string;
            rawSnippet?: string;
          };

          let pools: PoolRow[] = Array.isArray(data.pools) ? data.pools : [];
          if (data.ok === true && pools.length === 0 && data.poolAddress !== undefined && data.poolAddress.length > 0) {
            pools = [
              {
                rank: 1,
                poolAddress: data.poolAddress,
                pairHint: data.pairHint,
                notes: data.notes,
              },
            ];
          }

          if (!data.ok || pools.length === 0) {
            selectPaPoolList.hidden = true;
            const lines: string[] = [];
            if (data.error !== undefined && data.error.length > 0) {
              lines.push(data.error);
            }
            if (data.pairHint !== undefined && data.pairHint.length > 0) {
              lines.push(`pairHint: ${data.pairHint}`);
            }
            if (data.notes !== undefined && data.notes.length > 0) {
              lines.push(`notes: ${data.notes}`);
            }
            if (lines.length === 0) {
              lines.push(data.error ?? `HTTP ${res.status}`);
            }
            const extra =
              data.rawSnippet !== undefined && data.rawSnippet.length > 0
                ? `\n\n--- raw ---\n${data.rawSnippet}`
                : "";
            selectPaOut.textContent = `${lines.join("\n\n")}${extra}`;
            return;
          }

          const srcLabel =
            data.source === "dexscreener"
              ? "DexScreener"
              : data.source === "geckoterminal"
                ? "GeckoTerminal"
                : data.source === "perplexity"
                  ? "Perplexity"
                  : "API";
          selectPaOut.textContent = `${srcLabel}: ${pools.length} ranked pool(s) (max 5). Tap a row to select — top rank is pre-selected.`;

          selectPaPoolList.hidden = false;
          selectPaPoolList.innerHTML = "";
          const markSelected = (btn: HTMLButtonElement) => {
            selectPaPoolList.querySelectorAll(".select-pa-pool-row").forEach((el) => {
              el.classList.toggle("is-selected", el === btn);
            });
          };

          for (const p of pools) {
            const li = document.createElement("li");
            const btn = document.createElement("button");
            btn.type = "button";
            btn.className = "select-pa-pool-row";
            btn.dataset.pool = p.poolAddress;
            const rankSpan = document.createElement("span");
            rankSpan.className = "select-pa-pool-rank";
            rankSpan.textContent = `#${p.rank}`;
            const code = document.createElement("code");
            code.className = "select-pa-pool-addr";
            code.textContent = p.poolAddress;
            btn.append(rankSpan, code);
            const hint = p.pairHint?.trim() ?? "";
            if (hint.length > 0) {
              const pairEl = document.createElement("span");
              pairEl.className = "select-pa-pool-pair";
              pairEl.textContent = hint;
              btn.appendChild(pairEl);
            }
            const noteStr = p.notes?.trim() ?? "";
            if (noteStr.length > 0) {
              const notesEl = document.createElement("span");
              notesEl.className = "select-pa-pool-notes";
              notesEl.textContent = noteStr;
              btn.appendChild(notesEl);
            }
            btn.addEventListener("click", () => {
              lastSuggestedPool = p.poolAddress;
              btnSelectPaUse.disabled = false;
              markSelected(btn);
            });
            li.appendChild(btn);
            selectPaPoolList.appendChild(li);
          }

          const firstBtn = selectPaPoolList.querySelector<HTMLButtonElement>(".select-pa-pool-row");
          if (firstBtn !== null) {
            lastSuggestedPool = firstBtn.dataset.pool ?? pools[0].poolAddress;
            btnSelectPaUse.disabled = false;
            markSelected(firstBtn);
          }
        } catch (e) {
          selectPaPoolList.innerHTML = "";
          selectPaPoolList.hidden = true;
          selectPaOut.textContent =
            e instanceof Error
              ? `${e.message}\n\nIs the chart served via Vite dev or preview? Static hosting has no /api/suggest-gecko-pool.`
              : String(e);
        } finally {
          btnSelectPaSuggest.disabled = false;
        }
      })();
    });

    btnSelectPaUse.addEventListener("click", () => {
      if (lastSuggestedPool.length === 0) {
        return;
      }
      poolInput.value = lastSuggestedPool;
      void tick({ silent: false });
      window.location.hash = "#desk-hero";
    });
  }

  const btnVwmaApply = document.getElementById("btn-vwma-apply");
  if (btnVwmaApply instanceof HTMLButtonElement) {
    btnVwmaApply.addEventListener("click", () => {
      const inf = document.getElementById("vwma-fast");
      const inm = document.getElementById("vwma-mid");
      const ins = document.getElementById("vwma-slow");
      if (!(inf instanceof HTMLInputElement && inm instanceof HTMLInputElement && ins instanceof HTMLInputElement)) {
        return;
      }
      const parsed = parseVwmaPeriodInputs(inf.value, inm.value, ins.value);
      if (!parsed.ok) {
        chartToastError("VWMA periods", parsed.error);
        return;
      }
      saveVwmaPeriods(parsed.triple);
      deskStrategy = buildDeskStrategyConfig();
      syncDeskVwmaPresentation(deskStrategy.vwmaPeriods);
      const { fast, mid, slow } = parsed.triple;
      chartToastInfo(
        "Indicators applied",
        `VWMA periods set to ${fast} / ${mid} / ${slow}. Chart is refreshing with the new windows.`,
      );
      void tick({ silent: chartPrimed });
    });
  }

  btnNotify.addEventListener("click", () => {
    void requestNotifyPermission().then((p) => {
      const detail =
        p === "granted"
          ? "OS alerts enabled for BUY/SELL when the strategy fires on recent bars."
          : p === "denied"
            ? "OS alerts blocked — you will still see in-app toasts top-right."
            : "Permission not decided — OS alerts may be unavailable.";
      chartToastInfo(`Notifications: ${p}`, detail);
    });
  });

  const btnPosStartNew = document.getElementById("btn-positions-start-new");
  if (btnPosStartNew) {
    btnPosStartNew.addEventListener("click", () => {
      const openCount = openPositionPoolCount();
      const warning =
        openCount > 0
          ? ` ${openCount} pool${openCount === 1 ? " currently has" : "s currently have"} an open auto-bought position tracked — this also forgets that tracking, so only continue if you've confirmed the wallet is actually flat for ${openCount === 1 ? "it" : "them"} (e.g. on Solscan).`
          : "";
      if (
        !window.confirm(
          `Start trading fresh from now? All existing signal history stays exactly as-is — this only resets open-position tracking to flat, so the next BUY signal isn't blocked by old state.${warning}`,
        )
      ) {
        return;
      }
      resetTradePairingTracking();
      chartToastInfo(
        "Trading reset",
        "Open-position tracking cleared for every pool — signal history is untouched. The next signal starts fresh.",
      );
    });
  }
  const btnPosRefresh = document.getElementById("btn-positions-refresh");
  if (btnPosRefresh) {
    btnPosRefresh.addEventListener("click", () => {
      void syncPositionsFromServer().then(() => {
        const p = poolInput.value.trim();
        if (p) {
          rehydrateOpenPositionFromLog(p, loadLocalPositions());
        }
        onPositionsChanged();
      });
    });
  }
  const btnPosExport = document.getElementById("btn-positions-export");
  if (btnPosExport) {
    btnPosExport.addEventListener("click", () => {
      downloadPositionsTxt(loadLocalPositions());
    });
  }
  /**
   * Shared by the table header's trash icon (btn-positions-clear-all) and the "Clear" button in
   * the actions bar (btn-positions-clear) — same destructive action, two entry points, one
   * confirmation modal (`window.confirm`, same pattern as every other destructive action in this
   * app) so re-confirmation always happens regardless of which button was clicked.
   */
  const clearAllSignalHistory = (): void => {
    if (loadLocalPositions().length === 0) {
      return;
    }
    const openCount = openPositionPoolCount();
    const warning =
      openCount > 0
        ? ` WARNING: ${openCount} pool${openCount === 1 ? " has" : "s have"} an open auto-bought position tracked — clearing forgets that tracking, so auto-SELL will no longer close ${openCount === 1 ? "it" : "them"} (you'll need to sell manually via the wallet panel, or reload without clearing to let it rehydrate).`
        : "";
    if (!window.confirm(`Delete all signal history rows? This cannot be undone.${warning}`)) {
      return;
    }
    void clearAllPositions().then(() => {
      clearInMemoryOpenPositions();
      positionsPageIndex = 0;
      onPositionsChanged();
      chartToastInfo("Signal history cleared", "Every row was deleted. This cannot be undone.");
    });
  };
  const btnPosClearAll = document.getElementById("btn-positions-clear-all");
  if (btnPosClearAll) {
    btnPosClearAll.addEventListener("click", clearAllSignalHistory);
  }
  const btnPosClear = document.getElementById("btn-positions-clear");
  if (btnPosClear) {
    btnPosClear.addEventListener("click", clearAllSignalHistory);
  }
  const btnPosPrev = document.getElementById("btn-positions-prev");
  if (btnPosPrev) {
    btnPosPrev.addEventListener("click", () => {
      if (positionsPageIndex > 0) {
        positionsPageIndex -= 1;
        renderPositionsTableBody();
      }
    });
  }
  const btnPosNext = document.getElementById("btn-positions-next");
  if (btnPosNext) {
    btnPosNext.addEventListener("click", () => {
      const n = loadLocalPositions().length;
      if (n === 0) {
        return;
      }
      const totalPages = Math.ceil(n / POSITIONS_PAGE_SIZE);
      if (positionsPageIndex < totalPages - 1) {
        positionsPageIndex += 1;
        renderPositionsTableBody();
      }
    });
  }

  void syncPositionsFromServer().then(() => {
    const p = poolInput.value.trim();
    if (p) {
      rehydrateOpenPositionFromLog(p, loadLocalPositions());
    }
    onPositionsChanged();
  });

  // ── GeckoTerminal public rate-limit budget (fleet shape from PM2; see top of mount) ──────────
  // Auto-polling instances are evenly staggered across the poll window so the shared IP never
  // bursts: instance #i starts at offset i·pollSpacing, then re-schedules every ~POLL_WINDOW_MS
  // with a small jitter (≤ one spacing) so any cluster created by a manual Load / reconnect /
  // 429 cooldown gradually re-disperses instead of locking phase. Instances beyond
  // MAX_AUTOPOLL_AGENTS stay alive but only fetch on a manual Load press.

  // Each cycle: one poll window + jitter in [0, pollSpacing). The jitter never shortens the period,
  // so the per-instance rate stays ≤ 1 req / POLL_WINDOW_MS regardless of phase.
  const scheduleNextTick = (): void => {
    const jitterMs = Math.floor(Math.random() * pollSpacingMs);
    timer = window.setTimeout(() => {
      void tick({ silent: chartPrimed });
      scheduleNextTick();
    }, POLL_WINDOW_MS + jitterMs);
  };

  if (agentIdx >= MAX_AUTOPOLL_AGENTS) {
    // Over the per-IP auto-poll budget — keep alive but require a manual Load (no timer needed).
    showBanner(
      "info",
      `Auto-poll disabled for this slot (#${agentIdx + 1}). Max ${MAX_AUTOPOLL_AGENTS} auto-polling pools per IP for GeckoTerminal's public API. Press Load to fetch this pool manually.`,
    );
  } else {
    if (agentOffsetMs > 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, agentOffsetMs));
    }
    void tick({ silent: false });
    scheduleNextTick();
  }

  let onlineRetryTimer: number | undefined;
  window.addEventListener("online", () => {
    window.clearTimeout(onlineRetryTimer);
    // Stagger reconnect by this instance's offset so a network blip doesn't make every instance
    // re-fetch on the same instant (the classic post-reconnect 429 burst).
    onlineRetryTimer = window.setTimeout(() => {
      void tick({ silent: chartPrimed });
    }, 1200 + agentOffsetMs);
  });

  window.addEventListener("beforeunload", () => {
    ro.disconnect();
    if (timer !== undefined) {
      window.clearTimeout(timer);
    }
    window.clearTimeout(onlineRetryTimer);
    window.clearTimeout(visibleRangeDebounce);
    chart.timeScale().unsubscribeVisibleLogicalRangeChange(onVisibleLogicalRangeChanged);
    chart.remove();
  });
}

void mount().catch((e) => {
  console.error("[chart-web] mount failed:", e);
});
