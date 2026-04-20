/**
 * Phantom (browser) → Jupiter BUY/SELL using shared `executeJupiterSwap` (Model A).
 */

import { Connection, PublicKey, VersionedTransaction } from "@solana/web3.js";
import { executeJupiterSwap } from "@bot/execution/swapExecutor.js";
import type { OperationalMode } from "@bot/scope/stage0.js";
import { NATIVE_SOL_MINT } from "@bot/execution/types.js";

type PhantomLike = {
  isPhantom?: boolean;
  connect: (opts?: { onlyIfTrusted?: boolean }) => Promise<{ publicKey: PublicKey }>;
  disconnect: () => Promise<void>;
  signTransaction: (tx: VersionedTransaction) => Promise<VersionedTransaction>;
  publicKey: PublicKey | null;
};

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

/**
 * In Vite dev/preview (localhost or common private LAN IPs), call same-origin `/jupiter-api`
 * so the browser does not open a direct HTTPS tunnel to `quote-api.jup.ag` (see `vite.config.ts`).
 * That avoids `net::ERR_TUNNEL_CONNECTION_FAILED` when Chrome/system proxy breaks external HTTPS.
 */
function resolveJupiterApiBaseUrl(): string {
  const override = import.meta.env.VITE_JUPITER_API_BASE?.trim();
  if (override && override.length > 0) {
    return override.replace(/\/$/, "");
  }
  if (typeof window === "undefined" || !window.location?.origin?.startsWith("http")) {
    return "https://quote-api.jup.ag/v6";
  }
  const o = window.location.origin;
  const useLocalProxy =
    import.meta.env.DEV ||
    /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(o) ||
    /^https?:\/\/192\.168\.\d{1,3}\.\d{1,3}(:\d+)?$/i.test(o) ||
    /^https?:\/\/10\.\d{1,3}\.\d{1,3}\.\d{1,3}(:\d+)?$/i.test(o);
  if (useLocalProxy) {
    return `${o}/jupiter-api`;
  }
  return "https://quote-api.jup.ag/v6";
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
  root.className = "wallet-panel";
  const head = el(root, "div", "wallet-panel-head");
  const h = el(head, "h2", "wallet-panel-title");
  h.textContent = "Phantom wallet — Jupiter swaps";
  const sub = el(head, "p", "hint wallet-panel-sub");
  sub.innerHTML =
    "Connect <b>Phantom</b> (same seed/private key you imported). <b>BUY</b> spends SOL → token; <b>SELL</b> spends token → SOL. " +
    "On <code>npm run chart:dev</code>, Jupiter goes via this dev server (<code>/jupiter-api</code> proxy). If Vite logs <code>ENOTFOUND quote-api.jup.ag</code>, fix VM DNS (see <code>apps/chart-web/.env.example</code>). If a broken <code>HTTPS_PROXY</code> breaks Node, use <code>npm run chart:dev:direct-net</code> from the repo root. " +
    "Uncheck <i>Simulate only</i> and set <code>VITE_MODE=live</code> in <code>apps/chart-web/.env</code> for real mainnet sends (review size and risk first).";

  const rowConn = el(root, "div", "wallet-row");
  const btnConnect = el(rowConn, "button", "primary") as HTMLButtonElement;
  btnConnect.type = "button";
  btnConnect.textContent = "Connect Phantom";
  const btnDisc = el(rowConn, "button", "") as HTMLButtonElement;
  btnDisc.type = "button";
  btnDisc.textContent = "Disconnect";
  btnDisc.disabled = true;
  const status = el(rowConn, "span", "wallet-status");
  status.textContent = "Not connected";

  const grid = el(root, "div", "wallet-grid");
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

  const inpSellRaw = document.createElement("input");
  inpSellRaw.type = "number";
  inpSellRaw.min = "1";
  inpSellRaw.step = "1";
  inpSellRaw.value = "10000";
  mkField("SELL size (token raw units)", inpSellRaw);

  const inpSlip = document.createElement("input");
  inpSlip.type = "number";
  inpSlip.min = "1";
  inpSlip.max = "5000";
  inpSlip.value = "100";
  mkField("Slippage (bps)", inpSlip);

  const rowSim = el(root, "div", "wallet-row wallet-row-check");
  const chkSim = document.createElement("input");
  chkSim.type = "checkbox";
  chkSim.checked = true;
  const lblSim = document.createElement("label");
  lblSim.className = "wallet-check-label";
  lblSim.appendChild(chkSim);
  lblSim.appendChild(document.createTextNode(" Simulate only (quote + RPC simulate; no broadcast)"));
  rowSim.appendChild(lblSim);

  const policy = el(root, "div", "wallet-policy");
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

  const out = el(root, "pre", "wallet-out");
  out.textContent = "Output will appear here.";

  const rowBtns = el(root, "div", "wallet-row");
  const btnBuy = el(rowBtns, "button", "primary") as HTMLButtonElement;
  btnBuy.type = "button";
  btnBuy.textContent = "BUY (SOL → token)";
  const btnSell = el(rowBtns, "button", "") as HTMLButtonElement;
  btnSell.type = "button";
  btnSell.textContent = "SELL (token → SOL)";

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

  const connection = (): Connection => new Connection(inpRpc.value.trim() || env.rpcUrl, "confirmed");

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
    let amount: bigint;
    if (kind === "buy") {
      amount = BigInt(Math.floor(Number(inpBuyLamports.value)));
      if (amount <= 0n) {
        log("BUY lamports must be > 0.");
        return;
      }
    } else {
      amount = BigInt(Math.floor(Number(inpSellRaw.value)));
      if (amount <= 0n) {
        log("SELL token raw must be > 0.");
        return;
      }
    }

    const quoteParams =
      kind === "buy"
        ? {
            inputMint: NATIVE_SOL_MINT,
            outputMint: token,
            amount,
            slippageBps: slip,
          }
        : {
            inputMint: token,
            outputMint: NATIVE_SOL_MINT,
            amount,
            slippageBps: slip,
          };

    setBusy(true);
    log(`${kind.toUpperCase()}…`);
    try {
      const res = await executeJupiterSwap({
        connection: connection(),
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
      });
      const sigLine =
        res.signature !== undefined
          ? `Signature: ${res.signature}\nhttps://solscan.io/tx/${res.signature}`
          : "(simulate-only: no chain signature)";
      log(
        `OK ${kind.toUpperCase()} ${simOnly ? "(simulate)" : "(broadcast)"}\n${sigLine}\nSimulation err: ${JSON.stringify(res.simulation.value.err)}`,
      );
    } catch (e) {
      log(e instanceof Error ? e.message : String(e));
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
      log(`Connected ${pk.toBase58()}`);
    } catch (e) {
      pubkey = null;
      provider = null;
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
    log("Disconnected.");
  });

  btnBuy.addEventListener("click", () => void runLeg("buy"));
  btnSell.addEventListener("click", () => void runLeg("sell"));

  btnBuy.disabled = true;
  btnSell.disabled = true;
}
