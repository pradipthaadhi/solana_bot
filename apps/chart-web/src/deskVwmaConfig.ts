import {
  DEFAULT_STRATEGY_CONFIG,
  DEFAULT_VWMA_PERIODS,
  MAX_VWMA_PERIOD,
  type StrategyConfig,
  type VwmaPeriodTriple,
} from "@bot/strategy/strategyConfig.js";

const LS_KEY = "sol_bot_chart_vwma_periods_v1";

/** Clamp integers from DOM inputs into a valid triple. Defaults remain 3/9/18. */
export function parseVwmaPeriodInputs(rawFast: string, rawMid: string, rawSlow: string):
  | { ok: true; triple: VwmaPeriodTriple }
  | { ok: false; error: string } {
  const parseIntStrict = (_label: string, s: string): number | undefined => {
    const t = s.trim();
    if (!/^\d+$/.test(t)) {
      return undefined;
    }
    const n = Number.parseInt(t, 10);
    return Number.isFinite(n) ? n : undefined;
  };
  const a = parseIntStrict("fast", rawFast);
  const b = parseIntStrict("mid", rawMid);
  const c = parseIntStrict("slow", rawSlow);
  if (a === undefined || b === undefined || c === undefined) {
    return {
      ok: false,
      error: "Enter positive integers only for VWMA fast, mid, and slow periods.",
    };
  }
  if (a > MAX_VWMA_PERIOD || b > MAX_VWMA_PERIOD || c > MAX_VWMA_PERIOD) {
    return { ok: false, error: `Each period must be at most ${MAX_VWMA_PERIOD}.` };
  }
  if (!(a < b && b < c)) {
    return { ok: false, error: "Must satisfy fast < mid < slow (e.g. 3 < 9 < 18)." };
  }
  return { ok: true, triple: { fast: a, mid: b, slow: c } };
}

export function loadSavedVwmaPeriods(): VwmaPeriodTriple {
  try {
    const raw = globalThis.localStorage?.getItem(LS_KEY);
    if (raw === null || raw.trim().length === 0) {
      return DEFAULT_VWMA_PERIODS;
    }
    const o = JSON.parse(raw) as unknown;
    if (typeof o !== "object" || o === null) {
      return DEFAULT_VWMA_PERIODS;
    }
    const r = o as Record<string, unknown>;
    const fast = r.fast;
    const mid = r.mid;
    const slow = r.slow;
    if (
      typeof fast !== "number" ||
      typeof mid !== "number" ||
      typeof slow !== "number" ||
      !Number.isInteger(fast) ||
      !Number.isInteger(mid) ||
      !Number.isInteger(slow)
    ) {
      return DEFAULT_VWMA_PERIODS;
    }
    const parsed = parseVwmaPeriodInputs(String(fast), String(mid), String(slow));
    return parsed.ok ? parsed.triple : DEFAULT_VWMA_PERIODS;
  } catch {
    return DEFAULT_VWMA_PERIODS;
  }
}

export function saveVwmaPeriods(triple: VwmaPeriodTriple): void {
  try {
    globalThis.localStorage?.setItem(LS_KEY, JSON.stringify(triple));
  } catch {
    /* private mode */
  }
}

/** Desk runtime strategy: repo defaults + saved VWMA periods from localStorage. */
export function buildDeskStrategyConfig(): StrategyConfig {
  return { ...DEFAULT_STRATEGY_CONFIG, vwmaPeriods: loadSavedVwmaPeriods() };
}

export function applyVwmaPeriodInputs(elFast: HTMLInputElement, elMid: HTMLInputElement, elSlow: HTMLInputElement): void {
  const p = loadSavedVwmaPeriods();
  elFast.value = String(p.fast);
  elMid.value = String(p.mid);
  elSlow.value = String(p.slow);
}
