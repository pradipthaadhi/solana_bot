import "./style.css";
import {
  ColorType,
  CrosshairMode,
  createChart,
  type CandlestickData,
  type HistogramData,
  type IChartApi,
  type LineData,
  type UTCTimestamp,
} from "lightweight-charts";
import type { ExecutionAdapter, ExecutionSignalPayload } from "@bot/agent/executionAdapter.js";
import { SignalAgent } from "@bot/agent/signalAgent.js";
import { fetchSolanaPoolOhlcv1m } from "@bot/data/geckoTerminalOhlcv.js";
import type { Ohlcv } from "@bot/strategy/candleSemantics.js";
import { DEFAULT_STRATEGY_CONFIG } from "@bot/strategy/strategyConfig.js";
import type { StrategyEvent } from "@bot/strategy/types.js";
import { appendToast, notifyDesktop, requestNotifyPermission } from "./notify.js";
import { DEFAULT_DEMO_POOL_ADDRESS } from "./defaults.js";

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

function createNotifyExecution(pairLabel: string, toastHost: HTMLElement): ExecutionAdapter {
  return {
    onSignalEntry(p: ExecutionSignalPayload) {
      const msg = `${p.reason}\n${new Date(p.timeMs).toISOString()}`;
      notifyDesktop(`${pairLabel} — BUY (notify only)`, msg);
      appendToast(toastHost, `${pairLabel} — BUY`, msg);
    },
    onSignalExit(p: ExecutionSignalPayload) {
      const msg = `${p.reason}\n${new Date(p.timeMs).toISOString()}`;
      notifyDesktop(`${pairLabel} — SELL (notify only)`, msg);
      appendToast(toastHost, `${pairLabel} — SELL`, msg);
    },
  };
}

function tailBarEvents(events: readonly StrategyEvent[], lastIndex: number): StrategyEvent[] {
  return events.filter((e) => e.barIndex === lastIndex);
}

function mount(): void {
  const params = new URLSearchParams(window.location.search);
  const fromUrl = params.get("pool")?.trim();
  const initialPool = fromUrl && fromUrl.length > 0 ? fromUrl : DEFAULT_DEMO_POOL_ADDRESS;

  const app = $("#app");
  app.innerHTML = `
      <div class="toolbar">
        <input id="pool" type="text" spellcheck="false" autocomplete="off"
          placeholder="Solana pool address (GeckoTerminal pool id)" />
        <button id="btn-load" class="primary" type="button">Load</button>
        <button id="btn-notify" type="button">Enable notifications</button>
      </div>
      <div id="pair" style="font-weight:700;margin:6px 0 2px"></div>
      <div id="subpair" class="hint" style="margin-top:0;margin-bottom:8px"></div>
      <div class="metrics">
        <div class="metric"><div class="k">VWAP (UTC day)</div><div class="v" id="m-vwap">—</div></div>
        <div class="metric"><div class="k">VWMA (3)</div><div class="v" id="m-3">—</div></div>
        <div class="metric"><div class="k">VWMA (9)</div><div class="v" id="m-9">—</div></div>
        <div class="metric"><div class="k">VWMA (18)</div><div class="v" id="m-18">—</div></div>
      </div>
      <div id="banner" style="display:none" class="banner"></div>
      <div class="chart-wrap">
        <div id="chart-overlay" class="chart-overlay visible">Loading 1m OHLCV…</div>
        <div id="chart"></div>
      </div>
      <div class="hint">
        1m OHLCV from GeckoTerminal (public beta). A <b>demo pool</b> loads automatically so the chart is visible; paste your own pool id and click <b>Load</b>.
        Chart refreshes every <b>60s</b> and recomputes VWAP + VWMA 3/9/18. <b>No Solana transactions</b> — notifications only on the latest closed minute.
      </div>
  `;

  const toastHost = document.createElement("div");
  toastHost.id = "toasts";
  toastHost.className = "toast-wrap";
  document.body.appendChild(toastHost);

  const poolInput = $("#pool") as HTMLInputElement;
  poolInput.value = initialPool;

  const btnLoad = $("#btn-load") as HTMLButtonElement;
  const btnNotify = $("#btn-notify") as HTMLButtonElement;
  const banner = $("#banner");
  const pair = $("#pair");
  const subpair = $("#subpair");
  subpair.textContent =
    fromUrl && fromUrl.length > 0
      ? ""
      : "Demo Raydium SOL/USDC pool is pre-filled — chart loads on open. Replace with your GeckoTerminal pool id anytime.";
  const chartEl = $("#chart");
  const chartOverlay = $("#chart-overlay");

  const chart: IChartApi = createChart(chartEl, {
    width: chartEl.clientWidth,
    height: 520,
    layout: {
      background: { type: ColorType.Solid, color: "#0b0e11" },
      textColor: "#c7cbd1",
    },
    grid: {
      vertLines: { color: "rgba(43,49,57,0.55)" },
      horzLines: { color: "rgba(43,49,57,0.55)" },
    },
    crosshair: { mode: CrosshairMode.Normal },
    rightPriceScale: { borderColor: "#2b3139" },
    timeScale: { borderColor: "#2b3139", timeVisible: true, secondsVisible: false },
  });

  const candles = chart.addCandlestickSeries({
    upColor: "#26a69a",
    downColor: "#ef5350",
    borderUpColor: "#26a69a",
    borderDownColor: "#ef5350",
    wickUpColor: "#26a69a",
    wickDownColor: "#ef5350",
  });

  const vol = chart.addHistogramSeries({
    priceFormat: { type: "volume" },
    priceScaleId: "",
    color: "rgba(120,123,134,0.35)",
  });
  vol.priceScale().applyOptions({ scaleMargins: { top: 0.85, bottom: 0 } });

  const vwap = chart.addLineSeries({ color: "#e7e9ee", lineWidth: 2, title: "VWAP" });
  const w3 = chart.addLineSeries({ color: "#2962ff", lineWidth: 1, title: "VWMA 3" });
  const w9 = chart.addLineSeries({ color: "#9c27b0", lineWidth: 1, title: "VWMA 9" });
  const w18 = chart.addLineSeries({ color: "#fbc02d", lineWidth: 1, title: "VWMA 18" });

  const ro = new ResizeObserver(() => {
    chart.applyOptions({ width: chartEl.clientWidth, height: 520 });
  });
  ro.observe(chartEl);

  let timer: number | undefined;
  let busy = false;

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

  const apiBase = import.meta.env.DEV ? `${window.location.origin}/gt-api` : "https://api.geckoterminal.com/api/v2";

  const updateMetrics = (
    lastIdx: number,
    indicators: readonly { vwap: number; vwma3: number; vwma9: number; vwma18: number }[],
  ) => {
    const row = indicators[lastIdx];
    $("#m-vwap").textContent = fmt(row?.vwap);
    $("#m-3").textContent = fmt(row?.vwma3);
    $("#m-9").textContent = fmt(row?.vwma9);
    $("#m-18").textContent = fmt(row?.vwma18);
  };

  async function tick(): Promise<void> {
    const pool = poolInput.value.trim();
    if (!pool) {
      showBanner(
        "info",
        "Paste a Solana AMM pool address (GeckoTerminal pool id) and click Load. Find it on DexScreener → same pool on GeckoTerminal OHLCV.",
      );
      setChartOverlay(true, "No pool address — paste a pool id above, or reload to restore the demo pool.");
      return;
    }
    if (busy) {
      return;
    }
    busy = true;
    btnLoad.disabled = true;
    showBanner("hidden", "");
    setChartOverlay(true, "Loading 1m OHLCV…");
    try {
      const { bars, meta } = await fetchSolanaPoolOhlcv1m({
        poolAddress: pool,
        limit: 1000,
        apiBaseUrl: apiBase,
      });
      if (bars.length === 0) {
        showBanner(
          "err",
          "No OHLCV rows returned for that pool. Verify the pool id exists on GeckoTerminal (network: solana, timeframe: minute).",
        );
        setChartOverlay(true, "No candles returned for this pool id.");
        return;
      }

      const label = `${meta.baseSymbol ?? "BASE"}/${meta.quoteSymbol ?? "QUOTE"}`;
      pair.textContent = `${label} · 1m · pool ${pool}`;
      subpair.textContent =
        pool === DEFAULT_DEMO_POOL_ADDRESS
          ? "Demo: Raydium SOL/USDC — replace the address above for your pair."
          : "Indicators match repo FSM inputs (VWAP UTC day + VWMA 3/9/18 on 1m closes).";

      const agent = new SignalAgent({
        strategy: DEFAULT_STRATEGY_CONFIG,
        execution: createNotifyExecution(label, toastHost),
        executionHooksScope: "tail_bar_only",
        log: () => {},
      });

      const res = await agent.runTick(async () => bars);
      if (!res.ok) {
        showBanner("err", res.error);
        setChartOverlay(true, "Strategy / indicator step failed. See message above.");
        return;
      }

      candles.setData(toCandles(res.bars));
      vol.setData(toVolume(res.bars));
      vwap.setData(toLine(res.bars, res.indicators.map((i) => i.vwap)));
      w3.setData(toLine(res.bars, res.indicators.map((i) => i.vwma3)));
      w9.setData(toLine(res.bars, res.indicators.map((i) => i.vwma9)));
      w18.setData(toLine(res.bars, res.indicators.map((i) => i.vwma18)));
      chart.timeScale().fitContent();

      const lastIdx = res.bars.length - 1;
      updateMetrics(lastIdx, res.indicators);
      setChartOverlay(false);

      const tail = tailBarEvents(res.strategyEvents, lastIdx);
      for (const ev of tail) {
        if (ev.kind === "SIGNAL_ARMED" || ev.kind === "INVALIDATED") {
          appendToast(
            toastHost,
            `${label} — ${ev.kind}`,
            `${ev.reason}\n${new Date(res.bars[lastIdx]!.timeMs).toISOString()}`,
            8000,
          );
        }
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      showBanner("err", msg);
      setChartOverlay(
        true,
        "Network or API error. In dev, ensure the Vite proxy is used (/gt-api). In production, check CORS or host behind a proxy.",
      );
    } finally {
      busy = false;
      btnLoad.disabled = false;
    }
  }

  btnLoad.addEventListener("click", () => void tick());
  btnNotify.addEventListener("click", () => {
    void requestNotifyPermission().then((p) => {
      appendToast(toastHost, "Notifications", `Permission: ${p}`);
    });
  });

  window.setTimeout(() => void tick(), 0);
  timer = window.setInterval(() => void tick(), 60_000);

  window.addEventListener("beforeunload", () => {
    ro.disconnect();
    if (timer !== undefined) {
      window.clearInterval(timer);
    }
    chart.remove();
  });
}

mount();
