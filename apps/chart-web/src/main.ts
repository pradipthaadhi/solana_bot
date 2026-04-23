import "./polyfills.js";
import "./style.css";
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
  type Time,
  type UTCTimestamp,
} from "lightweight-charts";
import { SignalAgent } from "@bot/agent/signalAgent.js";
import {
  describeGeckoTerminalFetchError,
  fetchSolanaPoolOhlcv1m,
  mergeTailRefresh,
  prependOlderOhlcv,
  resolveAltTokenMintForSolPool,
} from "@bot/data/geckoTerminalOhlcv.js";
import type { Ohlcv } from "@bot/strategy/candleSemantics.js";
import type { BarIndicators } from "@bot/strategy/barIndicators.js";
import { STAGE8_EDUCATIONAL_FOOTER } from "@bot/scope/stage8.js";
import { DEFAULT_STRATEGY_CONFIG } from "@bot/strategy/strategyConfig.js";
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
import { downloadPositionsTxt, loadLocalPositions, syncPositionsFromServer } from "./positionsLog.js";
import { runFirstVisitIntro } from "./firstVisitIntro.js";
import { createAutoSwapExecutionAdapter } from "./signalAutoExecution.js";
import { initDeskTradingKeyFromEnv } from "./sessionTradingKey.js";
import { setSignalAutoSolInputToEnvDefaults } from "./signalTradeAmount.js";
import { setSessionPoolSwapTokenMint } from "./sessionPoolSwapMint.js";

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
/** Page size for `before_timestamp` requests (GeckoTerminal public rate limit: stay conservative). */
const HISTORY_PAGE_LIMIT = 500;

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

async function mount(): Promise<void> {
  mountChartToaster();
  const keyInit = initDeskTradingKeyFromEnv();
  if (!keyInit.ok) {
    chartToastError(
      "Desk private key",
      `Automatic signal swaps are disabled: ${keyInit.error} Set VITE_DESK_PRIVATE_KEY in apps/chart-web/.env (use a hot wallet; Vite embeds this value in the client bundle).`,
    );
  }
  const params = new URLSearchParams(window.location.search);
  const fromUrl = params.get("pool")?.trim();
  const initialPool = fromUrl && fromUrl.length > 0 ? fromUrl : DEFAULT_DEMO_POOL_ADDRESS;

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
                <span class="app-brand__name">sol_bot</span>
                <span class="app-brand__tag">Solana · chart desk</span>
              </div>
            </div>
            <nav class="desk-nav" aria-label="Section shortcuts">
              <a class="desk-nav__link" href="#desk-hero">Chart</a>
              <a class="desk-nav__link" href="#signal-log">Signals</a>
            </nav>
          </div>
          <div class="app-header__toolbar-row">
            <div class="toolbar" role="search">
              <input id="pool" type="text" spellcheck="false" autocomplete="off"
                placeholder="Pool address (GeckoTerminal id)" />
              <div class="toolbar-actions">
                <button id="btn-load" class="primary btn-pill-glow" type="button">Load pool →</button>
                <button id="btn-notify" class="btn-ghost-pill" type="button">Alerts</button>
                <a href="#signal-log" class="toolbar-link toolbar-link--caps">Log</a>
              </div>
            </div>
          </div>
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
            <div class="metric"><div class="k">VWMA (3)</div><div class="v" id="m-3">—</div></div>
            <div class="metric"><div class="k">VWMA (9)</div><div class="v" id="m-9">—</div></div>
            <div class="metric"><div class="k">VWMA (18)</div><div class="v" id="m-18">—</div></div>
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
          <div id="crosshair-hud" class="crosshair-hud" aria-live="polite"></div>
          <div id="banner" style="display:none" class="banner"></div>
          <div class="chart-wrap">
            <div id="chart-overlay" class="chart-overlay visible">Loading 1m OHLCV…</div>
            <div id="chart"></div>
          </div>
        </div>
      </div>
     
      <section id="signal-log" class="signal-log">
        <div class="signal-log-head">
          <h2 class="signal-log-title">Signal history</h2>
          <div class="signal-log-actions">
            <button id="btn-positions-refresh" type="button">Sync file</button>
            <button id="btn-positions-export" type="button">Download positions.txt</button>
          </div>
        </div>
        <p class="hint signal-log-hint">Newest first. <b>Tx</b> shows on-chain outcome for auto-execution (success / error / skipped). In <code>npm run chart:dev</code>, rows append to <code>apps/chart-web/positions.txt</code> via <code>POST /api/positions</code>. Production/static: localStorage only — use Download to save a file.</p>
        <div class="table-scroll">
          <table class="positions-table" aria-label="Historical BUY and SELL signals">
            <thead>
              <tr>
                <th>Time (UTC)</th>
                <th>Side</th>
                <th>Pair</th>
                <th>Pool</th>
                <th>Bar</th>
                <th>Reason</th>
                <th>Tx</th>
                <th>Tx detail</th>
              </tr>
            </thead>
            <tbody id="positions-tbody"></tbody>
          </table>
        </div>
      </section>
      <footer class="stage8-footer" role="note">${STAGE8_EDUCATIONAL_FOOTER}</footer>
  `;

  runFirstVisitIntro();

  const renderPositionsTableBody = (): void => {
    const tbody = document.getElementById("positions-tbody");
    if (!tbody) {
      return;
    }
    tbody.replaceChildren();
    const rows = loadLocalPositions().sort((a, b) => b.ts.localeCompare(a.ts));
    for (const r of rows) {
      const tr = document.createElement("tr");
      const tdTs = document.createElement("td");
      tdTs.textContent = r.ts;
      const tdSide = document.createElement("td");
      tdSide.textContent = r.side;
      tdSide.className = r.side === "BUY" ? "side-buy" : "side-sell";
      const tdPair = document.createElement("td");
      tdPair.textContent = r.pair;
      const tdPool = document.createElement("td");
      tdPool.textContent = r.pool;
      tdPool.className = "mono";
      const tdBar = document.createElement("td");
      tdBar.textContent = String(r.barIndex);
      const tdReason = document.createElement("td");
      tdReason.textContent = r.reason;
      tdReason.className = "reason-cell";
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
      tr.append(tdTs, tdSide, tdPair, tdPool, tdBar, tdReason, tdTx, tdTxDetail);
      tbody.appendChild(tr);
    }
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

  if (initialPool === DEFAULT_DEMO_POOL_ADDRESS) {
    pair.textContent = `${DEFAULT_DEMO_PAIR_LABEL} · 1m · pool ${initialPool}`;
    subpair.textContent = "Demo pool — replace the address above for your pair.";
  } else if (fromUrl && fromUrl.length > 0) {
    pair.textContent = `…/… · 1m · pool ${initialPool}`;
    subpair.textContent = "Loading pair from GeckoTerminal…";
  } else {
    pair.textContent = `· 1m · pool ${initialPool}`;
    subpair.textContent = "Paste a GeckoTerminal pool id or use the demo pool above.";
  }
  const chartEl = $("#chart");
  const chartOverlay = $("#chart-overlay");

  /** Merged OHLCV for the active pool (rolling tail + optional older pages from `before_timestamp`). */
  let sessionBars: Ohlcv[] = [];
  let sessionMergePool = "";
  let historyExhausted = false;
  let historyBusy = false;
  let lastPairLabel = DEFAULT_DEMO_PAIR_LABEL;

  // In `vite dev`, same-origin `/gt-api` uses `vite.config.ts` proxy (IPv4-preferring HTTPS agent) so flaky
  // browser/VPN/IPv6 paths do not block OHLCV. Production / `vite preview` hits Gecko directly.
  const apiBase = import.meta.env.DEV
    ? `${window.location.origin}/gt-api`
    : "https://api.geckoterminal.com/api/v2";
  /** Extra attempts for flaky Wi‑Fi / VPN / proxy (Chromium often reports only "Failed to fetch"). */
  const geckoFetchAttempts = 8;
  const geckoFetchTimeoutMs = 70_000;

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

  const vwap = chart.addLineSeries({ color: "#e7e9ee", lineWidth: 2, title: "VWAP", priceFormat: deskPriceFormat5 });
  const w3 = chart.addLineSeries({ color: "#2962ff", lineWidth: 1, title: "VWMA 3", priceFormat: deskPriceFormat5 });
  const w9 = chart.addLineSeries({ color: "#9945ff", lineWidth: 1, title: "VWMA 9", priceFormat: deskPriceFormat5 });
  const w18 = chart.addLineSeries({ color: "#14f195", lineWidth: 1, title: "VWMA 18", priceFormat: deskPriceFormat5 });

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
    if (!pool || historyExhausted || historyBusy || busy || sessionBars.length < 2) {
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
        maxAttempts: geckoFetchAttempts,
        fetchTimeoutMs: geckoFetchTimeoutMs,
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
      const agent = new SignalAgent({
        strategy: DEFAULT_STRATEGY_CONFIG,
        execution: createAutoSwapExecutionAdapter(lastPairLabel, pool, autoSwapDedupe, renderPositionsTableBody),
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
      console.warn("[chart-web] loading older OHLCV failed:", e);
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
    if (!pool) {
      setSessionPoolSwapTokenMint(null);
      showBanner(
        "info",
        "Paste a Solana AMM pool address (GeckoTerminal pool id) and click Load. Find it on DexScreener → same pool on GeckoTerminal OHLCV.",
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
        maxAttempts: geckoFetchAttempts,
        fetchTimeoutMs: geckoFetchTimeoutMs,
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
      }
      sessionBars = mergeTailRefresh(sessionBars, bars);

      const altMint = resolveAltTokenMintForSolPool(meta);
      setSessionPoolSwapTokenMint(altMint);

      const label = `${meta.baseSymbol ?? "BASE"}/${meta.quoteSymbol ?? "QUOTE"}`;
      lastPairLabel = label;
      pair.textContent = `${label} · 1m · pool ${pool}`;
      subpair.textContent =
        pool === DEFAULT_DEMO_POOL_ADDRESS
          ? "Demo pool — replace the address above for your pair."
          : "Indicators match repo FSM inputs (VWAP UTC day + VWMA 3/9/18 on 1m closes).";
      chartPrimed = true;

      const agent = new SignalAgent({
        strategy: DEFAULT_STRATEGY_CONFIG,
        execution: createAutoSwapExecutionAdapter(label, pool, autoSwapDedupe, renderPositionsTableBody),
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
      const msg = describeGeckoTerminalFetchError(e);
      if (silent && chartPrimed) {
        showBanner("hidden", "");
        console.warn("[chart-web] silent OHLCV refresh failed (will retry on next interval or when `online` fires):", e);
        setChartOverlay(false);
      } else {
        showBanner("err", msg);
        setChartOverlay(
          true,
          "Could not refresh GeckoTerminal OHLCV. See the banner above; the chart uses direct HTTPS (CORS), not the Vite proxy.",
        );
      }
    } finally {
      busy = false;
      if (!silent) {
        btnLoad.disabled = false;
      }
    }
  }

  btnLoad.addEventListener("click", () => void tick({ silent: false }));
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

  const btnPosRefresh = document.getElementById("btn-positions-refresh");
  if (btnPosRefresh) {
    btnPosRefresh.addEventListener("click", () => {
      void syncPositionsFromServer().then(renderPositionsTableBody);
    });
  }
  const btnPosExport = document.getElementById("btn-positions-export");
  if (btnPosExport) {
    btnPosExport.addEventListener("click", () => {
      downloadPositionsTxt(loadLocalPositions());
    });
  }

  void syncPositionsFromServer().then(renderPositionsTableBody);

  void tick({ silent: false });
  timer = window.setInterval(() => void tick({ silent: chartPrimed }), 60_000);

  let onlineRetryTimer: number | undefined;
  window.addEventListener("online", () => {
    window.clearTimeout(onlineRetryTimer);
    onlineRetryTimer = window.setTimeout(() => {
      void tick({ silent: chartPrimed });
    }, 1200);
  });

  window.addEventListener("beforeunload", () => {
    ro.disconnect();
    if (timer !== undefined) {
      window.clearInterval(timer);
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
