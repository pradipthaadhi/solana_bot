import type { JupiterQuoteParams, JupiterSwapMode, JupiterSwapRequest } from "./types.js";
import { JUPITER_V6_QUOTE_API_DEFAULT } from "./types.js";

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null;
}

export function readQuotedInputAmount(quote: unknown): bigint {
  if (!isRecord(quote)) {
    throw new Error("Invalid Jupiter quote: not an object.");
  }
  const v = quote.inAmount;
  if (typeof v === "string" && /^\d+$/.test(v)) {
    return BigInt(v);
  }
  if (typeof v === "number" && Number.isFinite(v) && v > 0) {
    return BigInt(Math.trunc(v));
  }
  throw new Error("Invalid Jupiter quote: inAmount must be a positive base-10 string or number.");
}

const SLIPPAGE_BASIS = 10_000n;

/**
 * Worst-case input the swap may require for safety checks.
 * For `ExactIn`, slippage is on the output — `inAmount` is the spend. For `ExactOut`, slippage is on
 * the **input**; the on-chain program may need up to `ceil(inAmount * (1 + slippageBps/10000))` raw units
 * of `inputMint` (see Jupiter swapMode docs), which can fail simulation with SPL `0x1` if only `inAmount`
 * fits the wallet.
 */
export function readMaxQuotedInputForPreflight(quote: unknown, swapMode: JupiterSwapMode | undefined, slippageBps: number): bigint {
  const base = readQuotedInputAmount(quote);
  if (swapMode !== "ExactOut" || slippageBps <= 0) {
    return base;
  }
  const s = BigInt(Math.min(Math.max(0, slippageBps), 1_000_000));
  return (base * (SLIPPAGE_BASIS + s) + SLIPPAGE_BASIS - 1n) / SLIPPAGE_BASIS;
}

export function buildJupiterQuoteUrl(params: JupiterQuoteParams, baseUrl = JUPITER_V6_QUOTE_API_DEFAULT): string {
  const url = new URL(`${baseUrl.replace(/\/$/, "")}/quote`);
  url.searchParams.set("inputMint", params.inputMint);
  url.searchParams.set("outputMint", params.outputMint);
  url.searchParams.set("amount", params.amount.toString());
  url.searchParams.set("slippageBps", String(params.slippageBps));
  if (params.onlyDirectRoutes === true) {
    url.searchParams.set("onlyDirectRoutes", "true");
  }
  if (params.swapMode === "ExactOut") {
    url.searchParams.set("swapMode", "ExactOut");
  }
  return url.toString();
}

export async function fetchJupiterQuote(
  params: JupiterQuoteParams,
  options?: { baseUrl?: string; fetchFn?: typeof fetch; signal?: AbortSignal },
): Promise<unknown> {
  const fetchFn = options?.fetchFn ?? fetch;
  const url = buildJupiterQuoteUrl(params, options?.baseUrl ?? JUPITER_V6_QUOTE_API_DEFAULT);
  const init: RequestInit = { method: "GET" };
  if (options?.signal !== undefined) {
    init.signal = options.signal;
  }
  const res = await fetchFn(url, init);
  if (!res.ok) {
    if (res.status >= 502 && res.status <= 504) {
      await res.text().catch(() => "");
      throw new Error("Jupiter quote service is temporarily unreachable.\n" + url);
    }
    const text = await res.text().catch(() => "");
    throw new Error(`Jupiter quote HTTP ${res.status}: ${text.slice(0, 400)}`);
  }
  return (await res.json()) as unknown;
}

export async function fetchJupiterSwapTransaction(
  body: JupiterSwapRequest,
  options?: { baseUrl?: string; fetchFn?: typeof fetch; signal?: AbortSignal },
): Promise<{ swapTransaction: string }> {
  const base = (options?.baseUrl ?? JUPITER_V6_QUOTE_API_DEFAULT).replace(/\/$/, "");
  const url = `${base}/swap`;
  const payload: Record<string, unknown> = {
    quoteResponse: body.quoteResponse,
    userPublicKey: body.userPublicKeyBase58,
    wrapAndUnwrapSol: body.wrapAndUnwrapSol ?? true,
    dynamicComputeUnitLimit: body.dynamicComputeUnitLimit ?? true,
    prioritizationFeeLamports: body.prioritizationFeeLamports ?? "auto",
  };
  const init: RequestInit = {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  };
  if (options?.signal !== undefined) {
    init.signal = options.signal;
  }
  const fetchFn = options?.fetchFn ?? fetch;
  const res = await fetchFn(url, init);
  if (!res.ok) {
    if (res.status >= 502 && res.status <= 504) {
      await res.text().catch(() => "");
      throw new Error("Jupiter swap service is temporarily unreachable.");
    }
    const text = await res.text().catch(() => "");
    throw new Error(`Jupiter swap HTTP ${res.status}: ${text.slice(0, 400)}`);
  }
  const json: unknown = await res.json();
  if (!isRecord(json)) {
    throw new Error("Jupiter swap: invalid JSON body.");
  }
  const st = json.swapTransaction;
  if (typeof st !== "string" || st.length === 0) {
    throw new Error("Jupiter swap: missing swapTransaction (base64).");
  }
  return { swapTransaction: st };
}
