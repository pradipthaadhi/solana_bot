import { PhantomWalletAdapter } from "@solana/wallet-adapter-wallets";
import { ConnectionProvider, useConnection, useWallet, WalletProvider } from "@solana/wallet-adapter-react";
import { WalletModalProvider, WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import type { ReactElement } from "react";
import { useMemo, useState } from "react";
import { executeJupiterSwap } from "@bot/execution/swapExecutor.js";
import type { JupiterQuoteParams, SafetyRails } from "@bot/execution/types.js";
import { NATIVE_SOL_MINT } from "@bot/execution/types.js";

const DEFAULT_RPC = "https://api.mainnet-beta.solana.com";
const DEFAULT_OUTPUT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

function Inner(): ReactElement {
  const { connection } = useConnection();
  const { publicKey, signTransaction, connected } = useWallet();
  const [outputMint, setOutputMint] = useState(DEFAULT_OUTPUT);
  const [buyLamports, setBuyLamports] = useState("50000");
  const [sellRaw, setSellRaw] = useState("1000");
  const [slippageBps, setSlippageBps] = useState("100");
  const [maxCap, setMaxCap] = useState("50000");
  const [killSwitch, setKillSwitch] = useState(false);
  const [simulateOnly, setSimulateOnly] = useState(true);
  const [busy, setBusy] = useState(false);
  const [log, setLog] = useState("");

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
    const rails: SafetyRails = {
      killSwitchEngaged: killSwitch,
      maxInputRaw: BigInt(maxCap || "0"),
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
          ? { broadcast: { broadcast: true, skipPreflight: false, commitment: "confirmed" as const } }
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
    const rails: SafetyRails = {
      killSwitchEngaged: killSwitch,
      maxInputRaw: BigInt(maxCap || "0"),
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
          ? { broadcast: { broadcast: true, skipPreflight: false, commitment: "confirmed" as const } }
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
        Mainnet swaps spend real funds when <b>Simulate only</b> is off. Use tiny amounts and a paid RPC. Educational software — no
        warranty.
      </p>

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
            <input type="checkbox" checked={killSwitch} onChange={(e) => setKillSwitch(e.target.checked)} /> Kill switch
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
    </>
  );
}

export function App(): ReactElement {
  const wallets = useMemo(() => [new PhantomWalletAdapter()], []);
  const [endpoint, setEndpoint] = useState(DEFAULT_RPC);

  return (
    <ConnectionProvider endpoint={endpoint} key={endpoint}>
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
    </ConnectionProvider>
  );
}
