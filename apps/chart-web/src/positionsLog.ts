/**
 * Persist BUY/SELL strategy signals to localStorage + optional dev server `positions.txt` (JSON Lines).
 */

export type TradeSide = "BUY" | "SELL";

/** Outcome of the optional on-chain leg for this signal row. */
export type SignalTxStatus = "ok" | "error" | "skipped";

export interface PositionSignalRow {
  /** ISO 8601 (bar close / signal time). */
  ts: string;
  side: TradeSide;
  pair: string;
  pool: string;
  barIndex: number;
  reason: string;
  /** Set when auto-execution runs or is skipped (older rows may omit). */
  txStatus?: SignalTxStatus;
  /** Error message, skip reason, or short success note (e.g. signature snippet). */
  txDetail?: string;
  /** Solana signature when `txStatus === "ok"`. */
  signature?: string;
}

const LS_KEY = "sol_bot_positions_v1";
const API = "/api/positions";

function readLocalRaw(): string {
  try {
    return globalThis.localStorage?.getItem(LS_KEY) ?? "";
  } catch {
    return "";
  }
}

function writeLocalRaw(raw: string): void {
  try {
    globalThis.localStorage?.setItem(LS_KEY, raw);
  } catch {
    /* quota / private mode */
  }
}

/** Parse JSONL (one JSON object per line); skips empty / invalid lines. */
export function parsePositionsTxt(text: string): PositionSignalRow[] {
  const out: PositionSignalRow[] = [];
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t) {
      continue;
    }
    try {
      const o = JSON.parse(t) as unknown;
      if (!isRow(o)) {
        continue;
      }
      out.push(o);
    } catch {
      continue;
    }
  }
  return out;
}

function isRow(x: unknown): x is PositionSignalRow {
  if (typeof x !== "object" || x === null) {
    return false;
  }
  const r = x as Record<string, unknown>;
  const base =
    typeof r.ts === "string" &&
    (r.side === "BUY" || r.side === "SELL") &&
    typeof r.pair === "string" &&
    typeof r.pool === "string" &&
    typeof r.barIndex === "number" &&
    typeof r.reason === "string";
  if (!base) {
    return false;
  }
  if (r.txStatus !== undefined && r.txStatus !== "ok" && r.txStatus !== "error" && r.txStatus !== "skipped") {
    return false;
  }
  if (r.txDetail !== undefined && typeof r.txDetail !== "string") {
    return false;
  }
  if (r.signature !== undefined && typeof r.signature !== "string") {
    return false;
  }
  return true;
}

export function rowToLine(r: PositionSignalRow): string {
  return `${JSON.stringify(r)}\n`;
}

/** All rows from localStorage (newest last in file order; we sort for display). */
export function loadLocalPositions(): PositionSignalRow[] {
  return parsePositionsTxt(readLocalRaw());
}

/** Merge server + local text, dedupe by ts|side|pool|barIndex. */
export function mergePositionRows(a: readonly PositionSignalRow[], b: readonly PositionSignalRow[]): PositionSignalRow[] {
  const key = (r: PositionSignalRow) => `${r.ts}\t${r.side}\t${r.pool}\t${r.barIndex}`;
  const map = new Map<string, PositionSignalRow>();
  for (const r of [...a, ...b]) {
    map.set(key(r), r);
  }
  return [...map.values()].sort((x, y) => x.ts.localeCompare(y.ts));
}

export function formatPositionsTxt(rows: readonly PositionSignalRow[]): string {
  return rows.map((r) => rowToLine(r).trimEnd()).join("\n") + (rows.length ? "\n" : "");
}

/** Append one row to localStorage and try dev POST (no-op if not running Vite API). */
export async function appendPosition(row: PositionSignalRow): Promise<void> {
  const line = rowToLine(row);
  const cur = readLocalRaw();
  writeLocalRaw(cur + line);
  try {
    await fetch(API, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: line.trimEnd(),
    });
  } catch {
    /* offline / static deploy */
  }
}

/** Load server file (dev) and merge into localStorage. */
export async function syncPositionsFromServer(): Promise<PositionSignalRow[]> {
  let serverTxt = "";
  try {
    const res = await fetch(API);
    if (res.ok) {
      serverTxt = await res.text();
    }
  } catch {
    return loadLocalPositions();
  }
  const fromServer = parsePositionsTxt(serverTxt);
  const merged = mergePositionRows(fromServer, loadLocalPositions());
  writeLocalRaw(formatPositionsTxt(merged));
  return merged;
}

export function downloadPositionsTxt(rows: readonly PositionSignalRow[]): void {
  const blob = new Blob([formatPositionsTxt(rows)], { type: "text/plain;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "positions_";
  a.click();
  URL.revokeObjectURL(a.href);
}
