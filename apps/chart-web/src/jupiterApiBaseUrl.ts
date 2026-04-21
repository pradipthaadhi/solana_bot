/** Canonical public Jupiter Swap API v1 root (for comparing env overrides). */
const PUBLIC_JUPITER_SWAP_V1_BASE = "https://api.jup.ag/swap/v1";

function normalizeApiBaseUrl(s: string): string {
  const t = s.trim().replace(/\/$/, "");
  try {
    const u = new URL(t);
    return `${u.protocol}//${u.host}${u.pathname}`.replace(/\/$/, "").toLowerCase();
  } catch {
    return t.toLowerCase();
  }
}

/**
 * Same-origin `/jupiter-api` in dev / common LAN hosts so the browser avoids broken HTTPS tunnels.
 */
export function resolveJupiterApiBaseUrl(): string {
  if (typeof window === "undefined" || !window.location?.origin?.startsWith("http")) {
    const override = import.meta.env.VITE_JUPITER_API_BASE?.trim();
    if (override && override.length > 0) {
      return override.replace(/\/$/, "");
    }
    return PUBLIC_JUPITER_SWAP_V1_BASE;
  }
  const o = window.location.origin;
  const useLocalProxy =
    import.meta.env.DEV ||
    /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(o) ||
    /^https?:\/\/192\.168\.\d{1,3}\.\d{1,3}(:\d+)?$/i.test(o) ||
    /^https?:\/\/10\.\d{1,3}\.\d{1,3}\.\d{1,3}(:\d+)?$/i.test(o);

  const overrideRaw = import.meta.env.VITE_JUPITER_API_BASE?.trim();
  if (overrideRaw && overrideRaw.length > 0) {
    const override = overrideRaw.replace(/\/$/, "");
    const isPublicSameAsDefault =
      normalizeApiBaseUrl(override) === normalizeApiBaseUrl(PUBLIC_JUPITER_SWAP_V1_BASE);
    if (import.meta.env.DEV && useLocalProxy && isPublicSameAsDefault) {
      return `${o}/jupiter-api`;
    }
    return override;
  }

  if (useLocalProxy) {
    return `${o}/jupiter-api`;
  }
  return PUBLIC_JUPITER_SWAP_V1_BASE;
}
