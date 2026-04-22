/**
 * Phantom (browser) → Jupiter BUY/SELL using shared `executeJupiterSwap` (Model A).
 * BUY can auto-sign with a pasted secret key (hot wallet — browser risk); SELL still uses Phantom.
 */

import { Connection, Keypair, PublicKey, VersionedTransaction } from "@solana/web3.js";
import { createKeypairSigner } from "@bot/execution/keypairSigner.js";
import { executeJupiterSwap } from "@bot/execution/swapExecutor.js";
import { NATIVE_SOL_MINT } from "@bot/execution/types.js";
import {
  chartToastError,
  chartToastInfo,
  chartToastSwapDone,
  chartToastWalletAccountSwitched,
  chartToastWalletConnected,
  chartToastWalletConnectFailed,
} from "./chartToaster.js";
import { readDeskEnv } from "./chartWebEnv.js";
import { resolveJupiterApiBaseUrl } from "./jupiterApiBaseUrl.js";
import { parseSecretKeyInput } from "./secretKeyParse.js";
import { getSessionTradingKeypair, setSessionTradingKeypair } from "./sessionTradingKey.js";

type PhantomLike = {
  isPhantom?: boolean;
  connect: (opts?: { onlyIfTrusted?: boolean }) => Promise<{ publicKey: PublicKey }>;
  disconnect: () => Promise<void>;
  signTransaction: (tx: VersionedTransaction) => Promise<VersionedTransaction>;
  publicKey: PublicKey | null;
};

function readPhantomAccounts(p: PhantomLike, primary: PublicKey): PublicKey[] {
  const out: PublicKey[] = [];
  const seen = new Set<string>();
  const push = (k: PublicKey): void => {
    const s = k.toBase58();
    if (seen.has(s)) {
      return;
    }
    seen.add(s);
    out.push(k);
  };
  push(primary);

  const raw = p as unknown as { accounts?: unknown };
  if (!Array.isArray(raw.accounts)) {
    return out;
  }
  for (const item of raw.accounts) {
    try {
      if (item instanceof PublicKey) {
        push(item);
      } else if (typeof item === "string") {
        push(new PublicKey(item));
      } else if (item && typeof item === "object") {
        if ("address" in item) {
          const a = (item as { address: unknown }).address;
          if (typeof a === "string") {
            push(new PublicKey(a));
          } else if (a instanceof Uint8Array) {
            push(new PublicKey(a));
          }
        } else if ("publicKey" in item) {
          const pk = (item as { publicKey: unknown }).publicKey;
          if (pk instanceof PublicKey) {
            push(pk);
          } else if (typeof pk === "string") {
            push(new PublicKey(pk));
          }
        }
      }
    } catch {
      /* skip malformed */
    }
  }
  return out.length > 0 ? out : [primary];
}

function attachPhantomAccountChanged(
  p: PhantomLike,
  onChange: (pk: PublicKey | null) => void,
): (() => void) | undefined {
  const bridge = p as unknown as {
    on?: (event: string, fn: (a: unknown) => void) => void;
    removeListener?: (event: string, fn: (a: unknown) => void) => void;
  };
  if (typeof bridge.on !== "function") {
    return undefined;
  }
  const handler = (pubkey: unknown): void => {
    if (pubkey == null) {
      onChange(null);
      return;
    }
    if (pubkey instanceof PublicKey) {
      onChange(pubkey);
      return;
    }
    try {
      onChange(new PublicKey(pubkey as string));
    } catch {
      onChange(null);
    }
  };
  bridge.on("accountChanged", handler);
  return () => {
    bridge.removeListener?.("accountChanged", handler);
  };
}

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

/** Phantom injects `window.solana` only in a [secure context](https://developer.mozilla.org/en-US/docs/Web/Security/Secure_Contexts) (https://, or http://localhost / 127.0.0.1). Plain http:// to a public IP is not secure — wallet connect will not work. */
function isBrowserWalletSecureContext(): boolean {
  return typeof window !== "undefined" && window.isSecureContext;
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
  const env = readDeskEnv();
  root.className = "wallet-panel-wrap";
  root.replaceChildren();
  const panel = el(root, "article", "wallet-panel");
  const inner = el(panel, "div", "wallet-panel-inner");

  const walletInsecure = !isBrowserWalletSecureContext();
  if (walletInsecure) {
    const notice = el(inner, "div", "wallet-insecure-notice");
    notice.setAttribute("role", "alert");
    // const strong = el(notice, "strong", "");
    // strong.textContent = "Phantom needs HTTPS (or localhost). ";
    // notice.appendChild(
    //   document.createTextNode(
    //     "This page is not a secure context (e.g. http:// plus a raw IP). The extension will not expose the wallet here. Serve the app over ",
    //   ),
    // );
    const link = document.createElement("a");
    link.href = "https://developer.mozilla.org/en-US/docs/Web/Security/Secure_Contexts";
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = "HTTPS";
    notice.appendChild(link);
    notice.appendChild(
      document.createTextNode(
        " (TLS certificate + domain), or use SSH port forwarding and open http://localhost:5173 on your machine.",
      ),
    );
  }

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

  const rowConn = el(inner, "div", "wallet-row wallet-row--connect");
  const btnConnect = el(rowConn, "button", "primary btn-connect-phantom") as HTMLButtonElement;
  btnConnect.type = "button";
  const connectIcon = document.createElement("img");
  connectIcon.src = "/branding/wallet.svg";
  connectIcon.alt = "";
  connectIcon.setAttribute("aria-hidden", "true");
  btnConnect.append(connectIcon, document.createTextNode(" Connect Phantom"));
  const btnDisc = el(rowConn, "button", "btn-wallet-disc") as HTMLButtonElement;
  btnDisc.type = "button";
  btnDisc.textContent = "Disconnect";
  btnDisc.disabled = true;
  const status = el(rowConn, "span", "wallet-status");
  status.textContent = "Not connected";

  const accountRow = el(inner, "div", "wallet-account-row");
  accountRow.hidden = true;
  const accountLabel = el(accountRow, "label", "wallet-account-label");
  const accountLabelText = el(accountLabel, "span", "wallet-field-label");
  accountLabelText.textContent = "Active account (Phantom)";
  const accountSelect = document.createElement("select");
  accountSelect.className = "wallet-account-select";
  accountSelect.setAttribute("aria-label", "Select Phantom wallet account");
  accountLabel.appendChild(accountSelect);

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
  inpMint.value = env.tokenMint;
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

  const secretFieldWrap = el(grid, "div", "wallet-field wallet-field--secret");
  const secretLabel = el(secretFieldWrap, "label", "wallet-field-label");
  secretLabel.htmlFor = "wallet-inp-secret";
  secretLabel.textContent = "Secret key (BUY; leave blank to use the desk session key from unlock)";
  const secretTooltip = el(secretFieldWrap, "div", "wallet-secret-tooltip");
  secretTooltip.id = "wallet-secret-tooltip";
  secretTooltip.setAttribute("role", "tooltip");
  secretTooltip.setAttribute("aria-live", "polite");
  secretTooltip.hidden = true;
  secretTooltip.textContent =
    "If empty, manual BUY uses the private key you entered at desk unlock. Paste here to sign from a different key.";
  const inpSecret = document.createElement("input");
  inpSecret.type = "password";
  inpSecret.className = "wallet-secret-input";
  inpSecret.id = "wallet-inp-secret";
  inpSecret.spellcheck = false;
  inpSecret.autocomplete = "off";
  inpSecret.placeholder = "Base58 or [byte,…] — required for Buy auto-sign";
  secretFieldWrap.appendChild(inpSecret);

  const clearSecretKeyError = (): void => {
    secretFieldWrap.classList.remove("wallet-field--secret-error");
    inpSecret.classList.remove("wallet-secret-input--error");
    inpSecret.removeAttribute("aria-invalid");
    inpSecret.removeAttribute("aria-describedby");
    secretTooltip.hidden = true;
  };

  const showSecretKeyRequired = (): void => {
    secretFieldWrap.classList.add("wallet-field--secret-error");
    inpSecret.classList.add("wallet-secret-input--error");
    inpSecret.setAttribute("aria-invalid", "true");
    inpSecret.setAttribute("aria-describedby", secretTooltip.id);
    secretTooltip.hidden = false;
    inpSecret.focus();
    inpSecret.scrollIntoView({ behavior: "smooth", block: "nearest" });
  };

  inpSecret.addEventListener("input", () => {
    if (inpSecret.value.trim().length > 0) {
      clearSecretKeyError();
    }
  });

  const metaRow = el(inner, "div", "wallet-meta");
  const rowSim = el(metaRow, "div", "wallet-row wallet-row-check");
  const chkSim = document.createElement("input");
  chkSim.type = "checkbox";
  /** Paper/replay: default safe dry-run. Live: default off so Buy/Sell can open Phantom and broadcast. */
  chkSim.checked = env.mode !== "live";

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
  let detachPhantomAccountListener: (() => void) | undefined;
  let connectInFlight = false;

  const setBusy = (b: boolean): void => {
    btnConnect.disabled = walletInsecure || b;
    btnDisc.disabled = b || pubkey === null;
    btnBuy.disabled = walletInsecure || b;
    btnSell.disabled = walletInsecure || b || pubkey === null;
  };

  const log = (msg: string): void => {
    out.textContent = msg;
  };

  const fillAccountSelect = (accounts: PublicKey[], active: PublicKey): void => {
    accountSelect.replaceChildren();
    if (accounts.length <= 1) {
      accountRow.hidden = true;
      return;
    }
    accountRow.hidden = false;
    for (const a of accounts) {
      const opt = document.createElement("option");
      const b58 = a.toBase58();
      opt.value = b58;
      opt.textContent = `${b58.slice(0, 4)}…${b58.slice(-4)}`;
      accountSelect.appendChild(opt);
    }
    accountSelect.value = active.toBase58();
  };

  async function disconnectWallet(): Promise<void> {
    detachPhantomAccountListener?.();
    detachPhantomAccountListener = undefined;
    try {
      const p = provider ?? getPhantom();
      await p?.disconnect();
    } catch {
      /* ignore */
    }
    provider = null;
    pubkey = null;
    btnDisc.disabled = true;
    accountRow.hidden = true;
    accountSelect.replaceChildren();
    status.textContent = "Not connected";
    status.classList.remove("wallet-status--live");
    log("Disconnected.");
  }

  const applyWalletSession = (p: PhantomLike, primary: PublicKey, showToast: boolean): void => {
    detachPhantomAccountListener?.();
    detachPhantomAccountListener = undefined;

    provider = p;
    pubkey = primary;
    const accounts = readPhantomAccounts(p, primary);
    fillAccountSelect(accounts, primary);

    btnDisc.disabled = false;
    status.textContent = `Connected: ${primary.toBase58().slice(0, 4)}…${primary.toBase58().slice(-4)}`;
    status.classList.add("wallet-status--live");
    log(`Connected ${primary.toBase58()}`);

    detachPhantomAccountListener = attachPhantomAccountChanged(p, (next) => {
      if (next === null) {
        void disconnectWallet();
        chartToastWalletConnectFailed("Phantom disconnected or revoked this site.");
        return;
      }
      pubkey = next;
      const accs = readPhantomAccounts(p, next);
      fillAccountSelect(accs, next);
      status.textContent = `Connected: ${next.toBase58().slice(0, 4)}…${next.toBase58().slice(-4)}`;
      log(`Account changed ${next.toBase58()}`);
      chartToastWalletAccountSwitched(next.toBase58());
    });

    if (showToast) {
      const detail =
        accounts.length > 1 ? `${accounts.length} accounts linked — pick the active address below.` : undefined;
      chartToastWalletConnected(primary.toBase58(), detail);
    }
  };

  async function runPhantomConnect(opts: { auto: boolean }): Promise<void> {
    if (connectInFlight) {
      return;
    }
    connectInFlight = true;
    try {
      if (!isBrowserWalletSecureContext()) {
        const msg =
          "Not a secure context: use https:// or http://localhost — Phantom will not connect on plain http:// to a remote IP.";
        log(msg);
        chartToastWalletConnectFailed(msg);
        return;
      }
      const p = getPhantom();
      if (!p) {
        const msg = window.isSecureContext
          ? "Install Phantom and allow this site (extension → Trusted apps)."
          : "Install Phantom — open this app over HTTPS or localhost.";
        log(msg);
        chartToastWalletConnectFailed(msg);
        return;
      }
      setBusy(true);
      log(opts.auto ? "Connecting Phantom…" : "Connecting…");
      let pk: PublicKey;
      try {
        pk = (await p.connect({ onlyIfTrusted: true })).publicKey;
      } catch {
        pk = (await p.connect()).publicKey;
      }
      applyWalletSession(p, pk, true);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      pubkey = null;
      provider = null;
      detachPhantomAccountListener?.();
      detachPhantomAccountListener = undefined;
      status.classList.remove("wallet-status--live");
      accountRow.hidden = true;
      accountSelect.replaceChildren();
      btnDisc.disabled = true;
      status.textContent = "Not connected";
      log(msg);
      chartToastWalletConnectFailed(msg);
    } finally {
      connectInFlight = false;
      setBusy(false);
    }
  }

  accountSelect.addEventListener("change", () => {
    if (!provider) {
      return;
    }
    try {
      const next = new PublicKey(accountSelect.value);
      pubkey = next;
      status.textContent = `Connected: ${next.toBase58().slice(0, 4)}…${next.toBase58().slice(-4)}`;
      log(`Using account ${next.toBase58()}`);
      chartToastWalletAccountSwitched(next.toBase58());
    } catch {
      /* ignore invalid */
    }
  });

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
    if (kind === "sell" && !pubkey) {
      log("Connect Phantom first for SELL.");
      chartToastError("Phantom required", "Connect Phantom to sign SELL (token → SOL).");
      return;
    }
    if (kind === "buy" && inpSecret.value.trim().length === 0 && getSessionTradingKeypair() === null) {
      showSecretKeyRequired();
      log("BUY aborted: paste a secret key, or complete desk unlock (private key on first load).");
      return;
    }
    clearSecretKeyError();
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

    let buyKeypair: Keypair | null = null;
    if (kind === "buy") {
      const rawSecret = inpSecret.value;
      if (rawSecret.trim().length === 0) {
        const fromDesk = getSessionTradingKeypair();
        if (fromDesk === null) {
          showSecretKeyRequired();
          log("BUY aborted: no session key and empty field.");
          return;
        }
        buyKeypair = fromDesk;
        setSessionTradingKeypair(fromDesk);
      } else {
        const parsed = parseSecretKeyInput(rawSecret);
        if (!parsed.ok) {
          chartToastError("Invalid private key", parsed.error);
          log(parsed.error);
          return;
        }
        buyKeypair = parsed.keypair;
        setSessionTradingKeypair(buyKeypair);
      }
      if (buyKeypair !== null && pubkey !== null && !buyKeypair.publicKey.equals(pubkey)) {
        chartToastInfo(
          "Signing wallet",
          `Secret key address ${buyKeypair.publicKey.toBase58().slice(0, 4)}… differs from connected Phantom — BUY will use the secret key.`,
          8000,
        );
      }
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
      splBalanceForSell = await readWalletSplTokenBalanceRaw(conn, pubkey!, token);
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

    const signerPk = kind === "buy" ? buyKeypair!.publicKey : pubkey!;
    const signTransaction =
      kind === "buy" ? createKeypairSigner(buyKeypair!) : signWithPhantom;

    setBusy(true);
    log(`${kind.toUpperCase()}…`);
    try {
      const res = await executeJupiterSwap({
        connection: conn,
        userPublicKeyBase58: signerPk.toBase58(),
        quoteParams,
        rails: {
          killSwitchEngaged: env.killSwitch,
          maxInputRaw: env.maxInputRaw,
          operationalMode: env.mode,
        },
        signTransaction,
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
      /** BUY always spends from the pasted secret key’s pubkey; Phantom’s selected account may differ. */
      const buySignerExplain =
        kind === "buy"
          ? `\nSigner (secret-key wallet): ${signerPk.toBase58()}\n` +
            `Token/SOL balances change on this address. Phantom only shows its own active account — if that is different, you will not see the swap there.`
          : "";
      const simExplain =
        simOnly && kind === "buy"
          ? `\n\nSimulate only: no broadcast; secret key was only used if the route required signing the sim transaction.${buySignerExplain}`
          : simOnly
            ? `\n\nNo on-chain send: "Simulate only" is checked.` +
              (env.mode !== "live"
                ? `\nFor a real swap: set VITE_MODE=live, uncheck "Simulate only", then try again.`
                : `\nUncheck "Simulate only" for a real swap${kind === "sell" ? " — Phantom will sign SELL." : "."}`)
            : buySignerExplain;
      log(
        `OK ${kind.toUpperCase()} ${simOnly ? "(simulate)" : "(broadcast)"}\n${sigLine}\nSimulation err: ${JSON.stringify(res.simulation.value.err)}${simExplain}`,
      );
      const leg = kind === "buy" ? "BUY" : "SELL";
      const shortDetail =
        res.signature !== undefined
          ? `Signature ${res.signature.slice(0, 10)}…\nhttps://solscan.io/tx/${res.signature}${
              kind === "buy"
                ? `\n\nSigner: ${signerPk.toBase58().slice(0, 4)}…${signerPk.toBase58().slice(-4)} — paste-key wallet (not necessarily Phantom)`
                : ""
            }`
          : "Simulated on RPC (no on-chain signature).";
      chartToastSwapDone(leg, simOnly ? "simulate" : "broadcast", shortDetail);
      if (kind === "buy") {
        inpSecret.value = "";
        clearSecretKeyError();
      }
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

  btnConnect.addEventListener("click", () => void runPhantomConnect({ auto: false }));

  btnDisc.addEventListener("click", () => void disconnectWallet());

  btnBuy.addEventListener("click", () => void runLeg("buy"));
  btnSell.addEventListener("click", () => void runLeg("sell"));

  if (walletInsecure) {
    setBusy(false);
    status.textContent = "Wallet blocked: need HTTPS or localhost (not http://IP)";
    log(
      "Phantom/Solana wallets only run in a secure browser context. Deploy behind nginx/Caddy with a TLS cert, or use: ssh -L 5173:127.0.0.1:5173 user@your-server then open localhost:5173.",
    );
  } else {
    setBusy(true);
    queueMicrotask(() => void runPhantomConnect({ auto: true }));
  }
}
