import { PhantomWalletAdapter } from "@solana/wallet-adapter-wallets";
import {
  ConnectionProvider,
  type ConnectionProviderProps,
  useConnection,
  useWallet,
  WalletProvider,
} from "@solana/wallet-adapter-react";
import { WalletModalProvider, WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import type { ComponentType, ReactElement } from "react";
import { useMemo, useState } from "react";

/**
 * Wallet-adapter declares `ConnectionProvider` as `FC<...>`; with `@types/react` 18 that can disagree
 * with JSX's expected component return type (React 19 widened `ReactNode`). Runtime is fine — this
 * is a types-only bridge.
 */
const SolanaConnectionProvider = ConnectionProvider as unknown as ComponentType<ConnectionProviderProps>;
import { executeJupiterSwap } from "@bot/execution/swapExecutor.js";
import type { JupiterQuoteParams, SafetyRails } from "@bot/execution/types.js";
import { NATIVE_SOL_MINT } from "@bot/execution/types.js";
import { STAGE8_EDUCATIONAL_FOOTER } from "@bot/scope/stage8.js";
import { readTraderViteEnv } from "./traderEnv.js";

const DEFAULT_RPC = "https://api.mainnet-beta.solana.com";
const DEFAULT_OUTPUT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

const TRADER_ENV = readTraderViteEnv();

function Inner(): ReactElement {
  const { connection } = useConnection();
  const { publicKey, signTransaction, connected } = useWallet();
  const [outputMint, setOutputMint] = useState(() => TRADER_ENV.defaultTokenMint ?? DEFAULT_OUTPUT);
  const [buyLamports, setBuyLamports] = useState("50000");
  const [sellRaw, setSellRaw] = useState("1000");
  const [slippageBps, setSlippageBps] = useState("100");
  const [maxCap, setMaxCap] = useState(() => String(TRADER_ENV.defaultMaxInputRaw ?? "50000"));
  const [killSwitch, setKillSwitch] = useState(false);
  const [simulateOnly, setSimulateOnly] = useState(true);
  const [busy, setBusy] = useState(false);
  const [log, setLog] = useState("");

  const rails: SafetyRails = useMemo(
    () => ({
      killSwitchEngaged: killSwitch || TRADER_ENV.envKillSwitch,
      maxInputRaw: BigInt(maxCap || "0"),
      operationalMode: TRADER_ENV.operationalMode,
    }),
    [killSwitch, maxCap],
  );

  /** On-chain send only in `live` when the user turns off simulate-only. */
  const willBroadcastOnChain = !simulateOnly && TRADER_ENV.operationalMode === "live";

  const append = (s: string) => {
    setLog((prev) => `${prev}\n${new Date().toISOString()} ${s}`.trim());
  };

  const runBuy = async () => {
    if (!publicKey || !signTransaction) {
      append("ERROR: connect Phantom first.");
      return;
    }
    const amount = BigInt(buyLamports);
    const quoteParams: JupiterQuoteParams = {
      inputMint: NATIVE_SOL_MINT,
      outputMint: outputMint.trim(),
      amount,
      slippageBps: Number(slippageBps) || 50,
    };
    setBusy(true);
    try {
      const res = await executeJupiterSwap({
        connection,
        userPublicKeyBase58: publicKey.toBase58(),
        quoteParams,
        rails,
        signTransaction: async (tx) => signTransaction(tx),
        simulateOnly,
        ...(!simulateOnly
          ? {
              broadcast: {
                broadcast: willBroadcastOnChain,
                skipPreflight: false,
                commitment: "confirmed" as const,
              },
            }
          : {}),
      });
      append(`OK BUY simulateOnly=${simulateOnly} signature=${res.signature ?? "(none)"}`);
      append(`sim-err=${JSON.stringify(res.simulation.value.err)}`);
    } catch (e) {
      append(`ERROR: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const runSell = async () => {
    if (!publicKey || !signTransaction) {
      append("ERROR: connect Phantom first.");
      return;
    }
    const amount = BigInt(sellRaw);
    const quoteParams: JupiterQuoteParams = {
      inputMint: outputMint.trim(),
      outputMint: NATIVE_SOL_MINT,
      amount,
      slippageBps: Number(slippageBps) || 50,
    };
    setBusy(true);
    try {
      const res = await executeJupiterSwap({
        connection,
        userPublicKeyBase58: publicKey.toBase58(),
        quoteParams,
        rails,
        signTransaction: async (tx) => signTransaction(tx),
        simulateOnly,
        ...(!simulateOnly
          ? {
              broadcast: {
                broadcast: willBroadcastOnChain,
                skipPreflight: false,
                commitment: "confirmed" as const,
              },
            }
          : {}),
      });
      append(`OK SELL simulateOnly=${simulateOnly} signature=${res.signature ?? "(none)"}`);
    } catch (e) {
      append(`ERROR: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <h1 style={{ fontSize: "1.25rem" }}>Stage 5 — Phantom + Jupiter</h1>
      <p className="warn">
        Mainnet swaps spend real funds when <b>Simulate only</b> is off, <code>VITE_MODE=live</code>, and broadcast is enabled. With{" "}
        <code>VITE_MODE=paper</code> or <code>replay</code>, signing may still run but the app will not send on-chain (sign-only
        rehearsal). Jupiter v6 + WSOL wrap/unwrap defaults apply. Educational software — no warranty.
      </p>

      <div className="panel" style={{ fontSize: 13, opacity: 0.9 }}>
        <div>
          <strong>Config (Stage 6)</strong> — <code>VITE_MODE</code>={TRADER_ENV.operationalMode}
          {TRADER_ENV.envKillSwitch ? (
            <>
              {" "}
              · kill switch <strong>on</strong> via <code>VITE_SOL_BOT_KILL_SWITCH</code>
            </>
          ) : null}
        </div>
      </div>

      <div className="panel">
        <div className="row" style={{ marginBottom: 10 }}>
          <WalletMultiButton />
          <span style={{ fontSize: 13, opacity: 0.85 }}>{connected ? publicKey?.toBase58() : "not connected"}</span>
        </div>
      </div>

      <div className="panel">
        <label htmlFor="out">Output mint (e.g. USDC)</label>
        <input id="out" type="text" value={outputMint} onChange={(e) => setOutputMint(e.target.value)} spellCheck={false} />

        <label htmlFor="buy">BUY: SOL (lamports, ExactIn)</label>
        <input id="buy" type="text" inputMode="numeric" value={buyLamports} onChange={(e) => setBuyLamports(e.target.value)} />

        <label htmlFor="sell">SELL: token raw amount (ExactIn)</label>
        <input id="sell" type="text" inputMode="numeric" value={sellRaw} onChange={(e) => setSellRaw(e.target.value)} />

        <label htmlFor="slip">Slippage bps</label>
        <input id="slip" type="number" value={slippageBps} onChange={(e) => setSlippageBps(e.target.value)} />

        <label htmlFor="cap">Safety cap — max input raw (≥ quoted inAmount)</label>
        <input id="cap" type="text" inputMode="numeric" value={maxCap} onChange={(e) => setMaxCap(e.target.value)} />

        <div className="row" style={{ marginTop: 10 }}>
          <label>
            <input type="checkbox" checked={simulateOnly} onChange={(e) => setSimulateOnly(e.target.checked)} /> Simulate only (no
            wallet sign / no send)
          </label>
        </div>
        <div className="row">
          <label>
            <input
              type="checkbox"
              checked={killSwitch || TRADER_ENV.envKillSwitch}
              disabled={TRADER_ENV.envKillSwitch}
              onChange={(e) => {
                if (!TRADER_ENV.envKillSwitch) setKillSwitch(e.target.checked);
              }}
            />{" "}
            Kill switch
            {TRADER_ENV.envKillSwitch ? " (locked on by VITE_SOL_BOT_KILL_SWITCH)" : ""}
          </label>
        </div>

        <div className="row">
          <button type="button" className="action" disabled={busy} onClick={() => void runBuy()}>
            Run BUY (SOL → mint)
          </button>
          <button type="button" className="action danger" disabled={busy} onClick={() => void runSell()}>
            Run SELL (mint → SOL)
          </button>
        </div>
      </div>

      <div className="panel">
        <div style={{ fontWeight: 600, marginBottom: 6 }}>Log</div>
        <pre className="log">{log || "—"}</pre>
      </div>

      <p className="hint" style={{ fontSize: 12, opacity: 0.82, marginTop: 12 }}>
        {STAGE8_EDUCATIONAL_FOOTER} Operator checklist: <code>docs/STAGE8_RISK_AND_COMPLIANCE.md</code> §7.
      </p>
    </>
  );
}

export function App(): ReactElement {
  const wallets = useMemo(() => [new PhantomWalletAdapter()], []);
  const [endpoint, setEndpoint] = useState(() => TRADER_ENV.defaultRpc ?? DEFAULT_RPC);

  return (
    <SolanaConnectionProvider endpoint={endpoint} key={endpoint}>
      <WalletProvider wallets={wallets} autoConnect={false}>
        <WalletModalProvider>
          <div className="panel">
            <label htmlFor="rpc">RPC URL (mainnet)</label>
            <input id="rpc" type="text" value={endpoint} onChange={(e) => setEndpoint(e.target.value.trim())} spellCheck={false} />
            <p style={{ fontSize: 12, opacity: 0.75, marginTop: 8 }}>Changing RPC remounts the Solana connection.</p>
          </div>
          <Inner />
        </WalletModalProvider>
      </WalletProvider>
    </SolanaConnectionProvider>
  );
}
