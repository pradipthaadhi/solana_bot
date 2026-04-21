/**
 * Phantom (browser) → Jupiter BUY/SELL using shared `executeJupiterSwap` (Model A).
 */

import { Connection, PublicKey, VersionedTransaction } from "@solana/web3.js";
import { executeJupiterSwap } from "@bot/execution/swapExecutor.js";
import type { OperationalMode } from "@bot/scope/stage0.js";
import { NATIVE_SOL_MINT } from "@bot/execution/types.js";
import { chartToastError, chartToastSwapDone } from "./chartToaster.js";

type PhantomLike = {
  isPhantom?: boolean;
  connect: (opts?: { onlyIfTrusted?: boolean }) => Promise<{ publicKey: PublicKey }>;
  disconnect: () => Promise<void>;
  signTransaction: (tx: VersionedTransaction) => Promise<VersionedTransaction>;
  publicKey: PublicKey | null;
};

async function readWalletSplTokenBalanceRaw(connection: Connection, owner: PublicKey, mintBase58: string): Promise<bigint> {
  const mint = new PublicKey(mintBase58);
  const res = await connection.getParsedTokenAccountsByOwner(owner, { mint });
  let total = 0n;
  for (const row of res.value) {
    const parsed = row.account.data.parsed;
    if (parsed && typeof parsed === "object" && "info" in parsed) {
      const info = (parsed as { info?: { tokenAmount?: { amount?: string } } }).info;
      const amt = info?.tokenAmount?.amount;
      if (typeof amt === "string" && /^\d+$/.test(amt)) {
        total += BigInt(amt);
      }
    }
  }
  return total;
}

function getPhantom(): PhantomLike | null {
  const w = window as unknown as { solana?: PhantomLike; phantom?: { solana?: PhantomLike } };
  if (w.solana?.isPhantom === true) {
    return w.solana;
  }
  if (w.phantom?.solana?.isPhantom === true) {
    return w.phantom.solana;
  }
  return null;
}

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
 * In Vite dev/preview (localhost or common private LAN IPs), call same-origin `/jupiter-api`
 * so the browser does not open a direct HTTPS tunnel to `api.jup.ag` (see `vite.config.ts`).
 * That avoids `net::ERR_TUNNEL_CONNECTION_FAILED` when Chrome/system proxy breaks external HTTPS.
 *
 * If `VITE_JUPITER_API_BASE` is set to the same public URL during local dev, it is ignored here so
 * `.env` copy-paste does not undo the proxy (direct browser → Jupiter often fails behind VPN/proxy).
 */
function resolveJupiterApiBaseUrl(): string {
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

function readEnv(): {
  rpcUrl: string;
  defaultTokenMint: string;
  maxInputRaw: bigint;
  mode: OperationalMode;
  killSwitch: boolean;
} {
  const modeRaw = (import.meta.env.VITE_MODE ?? "paper").trim().toLowerCase();
  const mode: OperationalMode =
    modeRaw === "live" || modeRaw === "replay" || modeRaw === "paper" ? modeRaw : "paper";
  return {
    rpcUrl: (import.meta.env.VITE_RPC_URL ?? "https://api.mainnet-beta.solana.com").trim(),
    defaultTokenMint: (import.meta.env.VITE_TOKEN_MINT ?? "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v").trim(),
    maxInputRaw: BigInt(import.meta.env.VITE_SOL_BOT_MAX_INPUT_RAW ?? "5000000"),
    mode,
    killSwitch: import.meta.env.VITE_SOL_BOT_KILL_SWITCH === "1",
  };
}

function el<K extends keyof HTMLElementTagNameMap>(parent: HTMLElement, tag: K, cls?: string): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  if (cls) {
    n.className = cls;
  }
  parent.appendChild(n);
  return n;
}

export function mountWalletTrading(root: HTMLElement): void {
  const env = readEnv();
  root.className = "wallet-panel-wrap";
  root.replaceChildren();
  const panel = el(root, "article", "wallet-panel");
  const inner = el(panel, "div", "wallet-panel-inner");

  const head = el(inner, "div", "wallet-panel-head");
  const titleBlock = el(head, "div", "wallet-panel-title-row");
  const logos = el(titleBlock, "div", "wallet-panel-logos");
  const logoJup = document.createElement("img");
  logoJup.src = "/branding/jupiter.svg";
  logoJup.alt = "Jupiter";
  logoJup.width = 32;
  logoJup.height = 32;
  const logoSol = document.createElement("img");
  logoSol.src = "/branding/solana.svg";
  logoSol.alt = "Solana";
  logoSol.width = 32;
  logoSol.height = 32;
  const logoWallet = document.createElement("img");
  logoWallet.src = "/branding/wallet.svg";
  logoWallet.alt = "";
  logoWallet.width = 32;
  logoWallet.height = 32;
  logos.append(logoJup, logoSol, logoWallet);

  const titles = el(titleBlock, "div", "");
  const h = el(titles, "h2", "wallet-panel-title");
  h.textContent = "Execution · Phantom × Jupiter";
  const sub = el(titles, "p", "wallet-panel-sub");
  sub.textContent =
    "On-chain swap rail: quote via Jupiter, sign in Phantom. Keep Simulate on until you deliberately run live.";

  const rowConn = el(inner, "div", "wallet-row");
  const btnConnect = el(rowConn, "button", "primary btn-connect-phantom") as HTMLButtonElement;
  btnConnect.type = "button";
  const connectIcon = document.createElement("img");
  connectIcon.src = "/branding/wallet.svg";
  connectIcon.alt = "";
  connectIcon.setAttribute("aria-hidden", "true");
  btnConnect.append(connectIcon, document.createTextNode(" Connect Phantom"));
  const btnDisc = el(rowConn, "button", "") as HTMLButtonElement;
  btnDisc.type = "button";
  btnDisc.textContent = "Disconnect";
  btnDisc.disabled = true;
  const status = el(rowConn, "span", "wallet-status");
  status.textContent = "Not connected";

  const grid = el(inner, "div", "wallet-grid");
  const mkField = (label: string, input: HTMLInputElement): void => {
    const wrap = el(grid, "label", "wallet-field");
    const span = el(wrap, "span", "wallet-field-label");
    span.textContent = label;
    wrap.appendChild(input);
  };

  const inpRpc = document.createElement("input");
  inpRpc.type = "text";
  inpRpc.value = env.rpcUrl;
  inpRpc.spellcheck = false;
  inpRpc.autocomplete = "off";
  mkField("RPC URL", inpRpc);

  const inpMint = document.createElement("input");
  inpMint.type = "text";
  inpMint.value = env.defaultTokenMint;
  inpMint.spellcheck = false;
  inpMint.autocomplete = "off";
  mkField("TOKEN_MINT (buy destination / sell source)", inpMint);

  const inpBuyLamports = document.createElement("input");
  inpBuyLamports.type = "number";
  inpBuyLamports.min = "1";
  inpBuyLamports.step = "1";
  inpBuyLamports.value = "1000000";
  mkField("BUY size (lamports, 1e9 = 1 SOL)", inpBuyLamports);

  const inpSellOutLamports = document.createElement("input");
  inpSellOutLamports.type = "number";
  inpSellOutLamports.min = "1";
  inpSellOutLamports.step = "1";
  inpSellOutLamports.value = "1000000";
  mkField("SELL target SOL out (lamports; 1e6 = 0.001 SOL)", inpSellOutLamports);

  const inpSlip = document.createElement("input");
  inpSlip.type = "number";
  inpSlip.min = "1";
  inpSlip.max = "5000";
  inpSlip.value = "100";
  mkField("Slippage (bps)", inpSlip);

  const rowSim = el(inner, "div", "wallet-row wallet-row-check");
  const chkSim = document.createElement("input");
  chkSim.type = "checkbox";
  /** Paper/replay: default safe dry-run. Live: default off so Buy/Sell can open Phantom and broadcast. */
  chkSim.checked = env.mode !== "live";
  const lblSim = document.createElement("label");
  lblSim.className = "wallet-check-label";
  lblSim.appendChild(chkSim);
  lblSim.appendChild(
    document.createTextNode(
      " Simulate only (quote + RPC simulate — no Phantom sign, balances unchanged; uncheck for on-chain swap when VITE_MODE=live)",
    ),
  );
  rowSim.appendChild(lblSim);

  const policy = el(inner, "div", "wallet-policy");
  const refreshPolicy = (): void => {
    const liveOk = env.mode === "live" && !env.killSwitch;
    policy.innerHTML = "";
    policy.appendChild(
      Object.assign(document.createElement("span"), {
        className: "wallet-policy-pill " + (liveOk ? "wallet-policy-live" : "wallet-policy-paper"),
        textContent:
          env.killSwitch ? "Kill switch ON (blocked)" : env.mode === "live" ? "VITE_MODE=live (broadcast allowed when not sim-only)" : `VITE_MODE=${env.mode} (broadcast disabled)`,
      }),
    );
  };
  refreshPolicy();

  const out = el(inner, "pre", "wallet-out");
  out.textContent = "Output will appear here.";

  const rowBtns = el(inner, "div", "wallet-actions");
  const btnBuy = el(rowBtns, "button", "primary btn-trade btn-trade--buy") as HTMLButtonElement;
  btnBuy.type = "button";
  btnBuy.textContent = "Buy SOL → token";
  const btnSell = el(rowBtns, "button", "btn-trade btn-trade--sell") as HTMLButtonElement;
  btnSell.type = "button";
  btnSell.textContent = "Sell token → SOL";

  let provider: PhantomLike | null = null;
  let pubkey: PublicKey | null = null;

  const setBusy = (b: boolean): void => {
    btnConnect.disabled = b;
    btnDisc.disabled = b || pubkey === null;
    btnBuy.disabled = b || pubkey === null;
    btnSell.disabled = b || pubkey === null;
  };

  const log = (msg: string): void => {
    out.textContent = msg;
  };

  const connection = (): Connection =>
    new Connection(inpRpc.value.trim() || env.rpcUrl, {
      commitment: "confirmed",
      /** Public RPC + browser: simulate/confirm can exceed defaults under load. */
      confirmTransactionInitialTimeout: 90_000,
    });

  const signWithPhantom = async (tx: VersionedTransaction): Promise<VersionedTransaction> => {
    const p = provider ?? getPhantom();
    if (!p) {
      throw new Error("Phantom not available");
    }
    return p.signTransaction(tx);
  };

  const runLeg = async (kind: "buy" | "sell"): Promise<void> => {
    if (!pubkey) {
      log("Connect Phantom first.");
      return;
    }
    const token = inpMint.value.trim();
    if (!token) {
      log("Set TOKEN_MINT.");
      return;
    }
    const slip = Math.floor(Number(inpSlip.value));
    if (!Number.isFinite(slip) || slip < 1 || slip > 5000) {
      log("Slippage must be 1–5000 bps.");
      return;
    }
    const simOnly = chkSim.checked;
    if (!simOnly && env.mode !== "live") {
      log(
        `On-chain swap is disabled while VITE_MODE=${env.mode}. Set VITE_MODE=live in apps/chart-web/.env, restart the dev server, leave "Simulate only" unchecked, then try again.`,
      );
      return;
    }
    let buyLamports: bigint | undefined;
    let sellTargetSolLamports: bigint | undefined;
    if (kind === "buy") {
      buyLamports = BigInt(Math.floor(Number(inpBuyLamports.value)));
      if (buyLamports <= 0n) {
        log("BUY lamports must be > 0.");
        return;
      }
    } else {
      sellTargetSolLamports = BigInt(Math.floor(Number(inpSellOutLamports.value)));
      if (sellTargetSolLamports <= 0n) {
        log("SELL target SOL out (lamports) must be > 0.");
        return;
      }
    }

    const conn = connection();
    let splBalanceForSell: bigint | undefined;
    if (kind === "sell") {
      splBalanceForSell = await readWalletSplTokenBalanceRaw(conn, pubkey, token);
      if (splBalanceForSell === 0n) {
        chartToastError(
          "Cannot sell",
          "No token balance for this mint — fund the token account or pick another TOKEN_MINT.",
        );
        log("SELL aborted: zero SPL balance for TOKEN_MINT.");
        return;
      }
    }

    const quoteParams =
      kind === "buy"
        ? {
            inputMint: NATIVE_SOL_MINT,
            outputMint: token,
            amount: buyLamports!,
            slippageBps: slip,
          }
        : {
            inputMint: token,
            outputMint: NATIVE_SOL_MINT,
            amount: sellTargetSolLamports!,
            slippageBps: slip,
            swapMode: "ExactOut" as const,
          };

    setBusy(true);
    log(`${kind.toUpperCase()}…`);
    try {
      const res = await executeJupiterSwap({
        connection: conn,
        userPublicKeyBase58: pubkey.toBase58(),
        quoteParams,
        rails: {
          killSwitchEngaged: env.killSwitch,
          maxInputRaw: env.maxInputRaw,
          operationalMode: env.mode,
        },
        signTransaction: signWithPhantom,
        simulateOnly: simOnly,
        jupiterBaseUrl: resolveJupiterApiBaseUrl(),
        /** Private RPC (VITE_RPC_URL) is required for reliable browser use; skip avoids redundant pre-check. */
        skipRpcHealthCheck: true,
        ...(kind === "sell" ? { preflightSplBalanceRaw: splBalanceForSell } : {}),
      });
      const sigLine =
        res.signature !== undefined
          ? `Signature: ${res.signature}\nhttps://solscan.io/tx/${res.signature}`
          : "(no on-chain signature — simulation only)";
      const simExplain = simOnly
        ? `\n\nNo swap in Phantom: "Simulate only" is checked (balances unchanged).` +
          (env.mode !== "live"
            ? `\nFor a real swap: set VITE_MODE=live in apps/chart-web/.env, restart npm run chart:dev, uncheck "Simulate only", then ${kind.toUpperCase()} again.`
            : `\nFor a real swap: uncheck "Simulate only" and click ${kind.toUpperCase()} again — Phantom will ask you to sign.`)
        : "";
      log(
        `OK ${kind.toUpperCase()} ${simOnly ? "(simulate)" : "(broadcast)"}\n${sigLine}\nSimulation err: ${JSON.stringify(res.simulation.value.err)}${simExplain}`,
      );
      const leg = kind === "buy" ? "BUY" : "SELL";
      const shortDetail =
        res.signature !== undefined
          ? `Signature ${res.signature.slice(0, 10)}…\nhttps://solscan.io/tx/${res.signature}`
          : "Simulated on RPC (no on-chain signature).";
      chartToastSwapDone(leg, simOnly ? "simulate" : "broadcast", shortDetail);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log(msg);
      if (msg.startsWith("INSUFFICIENT_TOKEN_BALANCE")) {
        chartToastError(
          "Insufficient token",
          "Not enough of the sell token to receive this much SOL. Add tokens, raise slippage slightly, or lower “SELL target SOL out (lamports)”.",
        );
      } else if (/Jupiter quote HTTP/i.test(msg)) {
        chartToastError(
          "No quote / route",
          "Jupiter could not quote this exact SOL output (no route or unsupported). Try another amount, token, or slippage.",
        );
      } else if (/MAX_INPUT_EXCEEDED/i.test(msg)) {
        chartToastError(
          "Size cap",
          "Swap would exceed VITE_SOL_BOT_MAX_INPUT_RAW — increase the cap in .env or use a smaller size.",
        );
      }
    } finally {
      setBusy(false);
    }
  };

  btnConnect.addEventListener("click", async () => {
    setBusy(true);
    log("Connecting…");
    try {
      const p = getPhantom();
      if (!p) {
        throw new Error("Install Phantom and allow this origin (https://phantom.app).");
      }
      const { publicKey: pk } = await p.connect();
      provider = p;
      pubkey = pk;
      btnDisc.disabled = false;
      status.textContent = `Connected: ${pk.toBase58().slice(0, 4)}…${pk.toBase58().slice(-4)}`;
      status.classList.add("wallet-status--live");
      log(`Connected ${pk.toBase58()}`);
    } catch (e) {
      pubkey = null;
      provider = null;
      status.classList.remove("wallet-status--live");
      log(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  });

  btnDisc.addEventListener("click", async () => {
    try {
      const p = provider ?? getPhantom();
      await p?.disconnect();
    } catch {
      /* ignore */
    }
    provider = null;
    pubkey = null;
    btnDisc.disabled = true;
    status.textContent = "Not connected";
    status.classList.remove("wallet-status--live");
    log("Disconnected.");
  });

  btnBuy.addEventListener("click", () => void runLeg("buy"));
  btnSell.addEventListener("click", () => void runLeg("sell"));

  btnBuy.disabled = true;
  btnSell.disabled = true;
}
