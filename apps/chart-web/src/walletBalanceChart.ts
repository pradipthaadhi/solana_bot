/**
 * "Wallet balance by trade" chart — x-axis is the sequence of BUY/SELL fills (event 1, 2, 3, …),
 * not wall-clock time. Trades are irregular in time (seconds apart or days apart), so a real time
 * axis buries the shape of the equity curve in long flat gaps; indexing by event keeps every fill
 * evenly spaced and comparable. Built on the same lightweight-charts instance as the rest of the
 * desk (index numbers stand in for `Time` so we get its axis/crosshair/resize machinery for free),
 * with the axis and crosshair label relabeled to "Trade N" instead of a date.
 */
import {
  ColorType,
  LineStyle,
  LineType,
  createChart,
  type IChartApi,
  type ISeriesApi,
  type SeriesMarker,
  type UTCTimestamp,
} from "lightweight-charts";
import type { PositionSignalRow } from "./positionsLog.js";

export interface BalanceEvent {
  /** 1-based position in the trade sequence — this IS the chart's x value. */
  index: number;
  side: "BUY" | "SELL";
  /** ISO 8601 signal time, for the hover readout only (not plotted). */
  ts: string;
  /** Desk wallet SOL balance right after this fill. */
  value: number;
  signature?: string;
}

export interface WalletBalanceChartHandle {
  setEvents(events: readonly BalanceEvent[]): void;
}

const LINE_COLOR = "#f5b942";
const AREA_TOP = "rgba(245, 185, 66, 0.10)";
const AREA_BOTTOM = "rgba(245, 185, 66, 0)";
const BUY_DOT_COLOR = "#00d68f";
const SELL_DOT_COLOR = "#ff3b5c";
/** Close match to the wallet-balance card's own dark surface — used as a marker "ring" so BUY/SELL
 * dots read as discrete marks instead of flat color blobs fused into the line/area beneath them. */
const MARKER_RING_COLOR = "#12151f";
const CROSSHAIR_LINE_COLOR = "rgba(245, 185, 66, 0.35)";
const CROSSHAIR_LABEL_BG = "#1c2130";

/** Rows with a recorded post-trade balance, in fill order, numbered 1..N. */
export function tradeBalanceEvents(rows: readonly PositionSignalRow[]): BalanceEvent[] {
  const withBalance = rows
    .filter((r): r is PositionSignalRow & { walletBalanceSol: number } => {
      return typeof r.walletBalanceSol === "number" && Number.isFinite(r.walletBalanceSol);
    })
    .sort((a, b) => a.ts.localeCompare(b.ts));
  return withBalance.map((r, i) => ({
    index: i + 1,
    side: r.side,
    ts: r.ts,
    value: r.walletBalanceSol,
    ...(r.signature && r.signature.length > 0 ? { signature: r.signature } : {}),
  }));
}

function renderHudLine(hudEl: HTMLElement, e: BalanceEvent): void {
  const badge = document.createElement("span");
  badge.className = `wallet-balance-hud__badge wallet-balance-hud__badge--${e.side.toLowerCase()}`;
  badge.textContent = e.side;

  const sig = e.signature ? ` · ${e.signature.slice(0, 8)}…` : "";
  const meta = document.createElement("span");
  meta.className = "wallet-balance-hud__meta";
  meta.textContent = `Trade ${e.index} · ${e.ts} · ${e.value.toFixed(4)} SOL${sig}`;

  hudEl.replaceChildren(badge, meta);
}

export function mountWalletBalanceChart(container: HTMLElement, hudEl?: HTMLElement | null): WalletBalanceChartHandle {
  const chart: IChartApi = createChart(container, {
    autoSize: true,
    layout: {
      background: { type: ColorType.Solid, color: "transparent" },
      textColor: "rgba(231,233,238,0.65)",
      fontSize: 11,
      attributionLogo: false,
    },
    grid: {
      vertLines: { visible: false },
      horzLines: { color: "rgba(120,132,160,0.08)" },
    },
    rightPriceScale: {
      borderVisible: false,
      scaleMargins: { top: 0.2, bottom: 0.15 },
    },
    timeScale: {
      borderVisible: false,
      // Time values here are trade indices (1, 2, 3, …), not dates — relabel both the axis
      // ticks and the crosshair time label so the axis reads "Trade N", never a 1970 date.
      tickMarkFormatter: (time: number) => `Trade ${time}`,
    },
    localization: {
      timeFormatter: (time: number) => `Trade ${time}`,
    },
    crosshair: {
      vertLine: {
        color: CROSSHAIR_LINE_COLOR,
        width: 1,
        style: LineStyle.Dotted,
        labelVisible: true,
        labelBackgroundColor: CROSSHAIR_LABEL_BG,
      },
      horzLine: {
        color: CROSSHAIR_LINE_COLOR,
        width: 1,
        style: LineStyle.Dotted,
        labelVisible: true,
        labelBackgroundColor: CROSSHAIR_LABEL_BG,
      },
    },
    handleScroll: false,
    handleScale: false,
  });

  const series: ISeriesApi<"Area"> = chart.addAreaSeries({
    lineColor: LINE_COLOR,
    topColor: AREA_TOP,
    bottomColor: AREA_BOTTOM,
    lineWidth: 2,
    lineType: LineType.Simple,
    pointMarkersVisible: false,
    priceFormat: { type: "price", precision: 4, minMove: 0.0001 },
    lastValueVisible: true,
    priceLineVisible: false,
    crosshairMarkerRadius: 6,
    crosshairMarkerBorderColor: MARKER_RING_COLOR,
    crosshairMarkerBackgroundColor: LINE_COLOR,
    crosshairMarkerBorderWidth: 2,
  });

  let currentEvents: BalanceEvent[] = [];

  const setHud = (e: BalanceEvent | null): void => {
    if (!hudEl) {
      return;
    }
    const target = e ?? (currentEvents.length > 0 ? currentEvents[currentEvents.length - 1]! : null);
    if (target) {
      renderHudLine(hudEl, target);
    } else {
      hudEl.replaceChildren();
    }
  };

  chart.subscribeCrosshairMove((param) => {
    if (currentEvents.length === 0) {
      return;
    }
    if (!param.time) {
      setHud(null);
      return;
    }
    const e = currentEvents[(param.time as number) - 1];
    setHud(e ?? null);
  });

  return {
    setEvents(events) {
      currentEvents = [...events];
      series.setData(currentEvents.map((e) => ({ time: e.index as UTCTimestamp, value: e.value })));
      // Two same-time "inBar" markers per fill: lightweight-charts has no native border for
      // SeriesMarker, so the ring is a second circle in the card's surface color drawn first —
      // inBar markers don't offset by draw order, so it sits exactly under the status-colored dot
      // drawn second, reading as one ringed mark rather than a flat blob. Circle radius is
      // `clamp(barSpacing, 12, 30) * size * 0.8` internally, clamped a SECOND time to [12,30] before
      // the 0.8 — so a ring `size` above 1 gets silently clamped back down to the same radius as a
      // `size: 1` fill once barSpacing alone already saturates that ceiling (a handful of sparse
      // trade points easily does). The reliable way to get a visible ring is the other direction:
      // ring at the library's natural size 1, fill deliberately smaller.
      const markers: SeriesMarker<UTCTimestamp>[] = currentEvents.flatMap((e) => {
        const time = e.index as UTCTimestamp;
        const fillColor = e.side === "BUY" ? BUY_DOT_COLOR : SELL_DOT_COLOR;
        return [
          { time, position: "inBar", shape: "circle", color: MARKER_RING_COLOR, size: 1 },
          { time, position: "inBar", shape: "circle", color: fillColor, size: 0.55 },
        ];
      });
      series.setMarkers(markers);
      if (currentEvents.length > 0) {
        chart.timeScale().fitContent();
      }
      setHud(null);
    },
  };
}
