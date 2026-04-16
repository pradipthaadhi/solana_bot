/** Stable UTC calendar day key for VWAP session resets (Stage 1.3 / 3.1). */
export function utcDayKeyUtc(timeMs: number): string {
  const d = new Date(timeMs);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
