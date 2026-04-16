/**
 * Aligned per-bar indicator snapshot consumed by the FSM (Stages 3–4).
 */
export interface BarIndicators {
  vwap: number;
  vwma3: number;
  vwma9: number;
  vwma18: number;
}

export function indicatorsRowFinite(ind: BarIndicators): boolean {
  return (
    Number.isFinite(ind.vwap) &&
    Number.isFinite(ind.vwma3) &&
    Number.isFinite(ind.vwma9) &&
    Number.isFinite(ind.vwma18)
  );
}
