/**
 * Stage 1.2 / 3.1 — volume-weighted moving average over the last `period` closes (inclusive).
 * If the rolling volume sum is 0, the value is NaN (signals skipped upstream).
 */

export function computeVwmaSeries(closes: readonly number[], volumes: readonly number[], period: number): number[] {
  if (period < 1) {
    throw new Error("VWMA period must be >= 1");
  }
  if (closes.length !== volumes.length) {
    throw new Error("closes and volumes must have the same length");
  }
  const n = closes.length;
  const out = new Array<number>(n).fill(Number.NaN);
  for (let i = 0; i < n; i++) {
    const start = i - period + 1;
    if (start < 0) {
      continue;
    }
    let num = 0;
    let den = 0;
    for (let k = start; k <= i; k++) {
      const c = closes[k]!;
      const v = volumes[k]!;
      num += c * v;
      den += v;
    }
    out[i] = den > 0 ? num / den : Number.NaN;
  }
  return out;
}
