import type { Connection, PublicKey } from "@solana/web3.js";
import { useCallback, useEffect, useRef, useState, type ReactElement } from "react";
import { createDedupingExecutionAdapter } from "@bot/agent/executionAdapter.js";
import { SignalAgent } from "@bot/agent/signalAgent.js";
import { createJupiterSignalExecutionAdapter } from "@bot/execution/jupiterExecutionAdapter.js";
import type { OperationalMode } from "@bot/scope/stage0.js";
import { assertBrowserExecPolicy, createBrowserJupiterSignalAgent } from "@bot/signalExec/browserJupiterSignalAgent.js";
import { fetchSolanaPoolOhlcv1m } from "@bot/data/geckoTerminalOhlcv.js";
import { executeJupiterSwap } from "@bot/execution/swapExecutor.js";
import type { JupiterQuoteParams, SafetyRails } from "@bot/execution/types.js";
import { NATIVE_SOL_MINT } from "@bot/execution/types.js";
import { resolveTraderSigning, signingMaterialFromResolved } from "@bot/traderSigning/resolveTraderSigning.js";
import type { SignVersionedTransaction } from "@bot/execution/types.js";

const DEFAULT_GECKO_POOL = "58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2";
const GECKO_API = "https://api.geckoterminal.com/api/v2";
const GECKO_FETCH_ATTEMPTS = 5;
const GECKO_TIMEOUT_MS = 55_000;

export interface SignalBotPanelProps {
  connection: Connection;
  operationalMode: OperationalMode;
  envKillSwitch: boolean;
  rails: SafetyRails;
  simulateOnly: boolean;
  willBroadcastOnChain: boolean;
  outputMint: string;
  buyLamportsStr: string;
  sellRawStr: string;
  slippageBpsStr: string;
  append: (line: string) => void;
  walletConnected: boolean;
  walletPublicKey: PublicKey | null;
  walletSignTransaction: SignVersionedTransaction | undefined;
}

export function SignalBotPanel(props: SignalBotPanelProps): ReactElement {
  const {
    connection,
    operationalMode,
    envKillSwitch,
    rails,
    simulateOnly,
    willBroadcastOnChain,
    outputMint,
    buyLamportsStr,
    sellRawStr,
    slippageBpsStr,
    append,
    walletConnected,
    walletPublicKey,
    walletSignTransaction,
  } = props;

  const [poolAddress, setPoolAddress] = useState(DEFAULT_GECKO_POOL);
  const [pollMsStr, setPollMsStr] = useState("60000");
  const [automationPermission, setAutomationPermission] = useState(false);
  const [automationSecret, setAutomationSecret] = useState("");
  const [running, setRunning] = useState(false);
  const [testBusy, setTestBusy] = useState(false);

  const agentRef = useRef<SignalAgent | null>(null);

  useEffect(() => {
    if (!automationPermission) {
      setAutomationSecret("");
    }
  }, [automationPermission]);

  const parsePositiveBigInt = (raw: string, label: string): bigint => {
    const t = raw.trim();
    if (t.length === 0) {
      throw new Error(`${label} is empty`);
    }
    const n = BigInt(t);
    if (n <= 0n) {
      throw new Error(`${label} must be > 0`);
    }
    return n;
  };

  const buildSigningMaterial = useCallback(() => {
    const resolved = resolveTraderSigning({
      automationPermissionGranted: automationPermission,
      automationSecretText: automationSecret,
      walletConnected,
      walletSignTransaction,
      walletPublicKey: walletPublicKey ?? undefined,
    });
    const mat = signingMaterialFromResolved(resolved);
    if (!mat) {
      const reason = resolved.kind === "none" ? resolved.reason : "Unknown signing error";
      throw new Error(reason);
    }
    return mat;
  }, [
    automationPermission,
    automationSecret,
    walletConnected,
    walletSignTransaction,
    walletPublicKey,
  ]);

  const buildJupiterExecutionAdapter = useCallback(() => {
    assertBrowserExecPolicy({
      operationalMode,
      simulateOnly,
      killSwitchEngaged: rails.killSwitchEngaged,
    });
    const mat = buildSigningMaterial();
    const buyLamports = parsePositiveBigInt(buyLamportsStr, "BUY lamports");
    const sellTokenRaw = parsePositiveBigInt(sellRawStr, "SELL token raw");
    const slip = Math.floor(Number(slippageBpsStr) || 0);
    if (!Number.isFinite(slip) || slip < 1 || slip > 5000) {
      throw new Error("Slippage bps must be between 1 and 5000");
    }
    const mint = outputMint.trim();
    if (!mint) {
      throw new Error("Output mint is required");
    }
    const inner = createJupiterSignalExecutionAdapter({
      connection,
      userPublicKeyBase58: mat.userPublicKeyBase58,
      signTransaction: mat.signTransaction,
      rails,
      slippageBps: slip,
      targetMint: mint,
      buySpendLamports: buyLamports,
      sellTokenRaw,
      simulateOnly,
    });
    return createDedupingExecutionAdapter(inner);
  }, [
    buildSigningMaterial,
    buyLamportsStr,
    connection,
    outputMint,
    rails,
    sellRawStr,
    simulateOnly,
    slippageBpsStr,
    operationalMode,
  ]);

  const buildAgent = useCallback((): SignalAgent => {
    assertBrowserExecPolicy({
      operationalMode,
      simulateOnly,
      killSwitchEngaged: rails.killSwitchEngaged,
    });
    const mat = buildSigningMaterial();
    const buyLamports = parsePositiveBigInt(buyLamportsStr, "BUY lamports");
    const sellTokenRaw = parsePositiveBigInt(sellRawStr, "SELL token raw");
    const slip = Math.floor(Number(slippageBpsStr) || 0);
    if (!Number.isFinite(slip) || slip < 1 || slip > 5000) {
      throw new Error("Slippage bps must be between 1 and 5000");
    }
    const mint = outputMint.trim();
    if (!mint) {
      throw new Error("Output mint is required");
    }
    return createBrowserJupiterSignalAgent(
      {
        connection,
        userPublicKeyBase58: mat.userPublicKeyBase58,
        signTransaction: mat.signTransaction,
        rails,
        slippageBps: slip,
        targetMint: mint,
        buySpendLamports: buyLamports,
        sellTokenRaw,
        simulateOnly,
      },
      { log: () => {} },
    );
  }, [
    buildSigningMaterial,
    buyLamportsStr,
    connection,
    outputMint,
    rails,
    sellRawStr,
    simulateOnly,
    slippageBpsStr,
    operationalMode,
  ]);

  useEffect(() => {
    if (!running) {
      return;
    }
    const agent = agentRef.current;
    if (!agent) {
      return;
    }
    const pollMs = Math.max(5000, Math.floor(Number(pollMsStr) || 60_000));
    const tick = async () => {
      const pool = poolAddress.trim();
      if (!pool) {
        append("[bot] skip tick: empty pool");
        return;
      }
      try {
        const { bars } = await fetchSolanaPoolOhlcv1m({
          poolAddress: pool,
          limit: 1000,
          apiBaseUrl: GECKO_API,
          maxAttempts: GECKO_FETCH_ATTEMPTS,
          fetchTimeoutMs: GECKO_TIMEOUT_MS,
        });
        const res = await agent.runTick(async () => bars);
        if (res.ok) {
          append(`[bot] poll ok bars=${bars.length} events=${res.strategyEvents.length}`);
        } else {
          append(`[bot] poll strategy error: ${res.error}`);
        }
      } catch (e) {
        append(`[bot] poll fetch/error: ${e instanceof Error ? e.message : String(e)}`);
      }
    };
    void tick();
    const id = window.setInterval(() => void tick(), pollMs);
    return () => window.clearInterval(id);
  }, [running, poolAddress, pollMsStr, append]);

  const startBot = (): void => {
    if (running) {
      return;
    }
    try {
      const agent = buildAgent();
      agentRef.current = agent;
      setRunning(true);
      append(
        `[bot] started pool=${poolAddress.trim()} pollMs=${pollMsStr} signing=${
          automationPermission ? "automation_keypair" : "manual_wallet"
        }`,
      );
    } catch (e) {
      append(`[bot] start failed: ${e instanceof Error ? e.message : String(e)}`);
      agentRef.current = null;
    }
  };

  const stopBot = (): void => {
    setRunning(false);
    agentRef.current = null;
    append("[bot] stopped");
  };

  const swapBroadcastOpts =
    !simulateOnly && willBroadcastOnChain
      ? {
          broadcast: {
            broadcast: true as const,
            skipPreflight: false,
            commitment: "confirmed" as const,
          },
        }
      : {};

  const runTestLeg = async (side: "buy" | "sell"): Promise<void> => {
    setTestBusy(true);
    try {
      assertBrowserExecPolicy({
        operationalMode,
        simulateOnly,
        killSwitchEngaged: rails.killSwitchEngaged,
      });
      const mat = buildSigningMaterial();
      const slip = Math.floor(Number(slippageBpsStr) || 100);
      const mint = outputMint.trim();
      if (!mint) {
        throw new Error("Output mint required");
      }
      const buyLamports = parsePositiveBigInt(buyLamportsStr, "BUY lamports");
      const sellTokenRaw = parsePositiveBigInt(sellRawStr, "SELL token raw");
      const quoteParams: JupiterQuoteParams =
        side === "buy"
          ? {
              inputMint: NATIVE_SOL_MINT,
              outputMint: mint,
              amount: buyLamports,
              slippageBps: slip,
            }
          : {
              inputMint: mint,
              outputMint: NATIVE_SOL_MINT,
              amount: sellTokenRaw,
              slippageBps: slip,
            };
      const res = await executeJupiterSwap({
        connection,
        userPublicKeyBase58: mat.userPublicKeyBase58,
        quoteParams,
        rails,
        signTransaction: mat.signTransaction,
        simulateOnly,
        ...swapBroadcastOpts,
      });
      append(
        `[test ${side.toUpperCase()}] simulateOnly=${simulateOnly} signature=${res.signature ?? "(none)"} err=${JSON.stringify(res.simulation.value.err)}`,
      );
    } catch (e) {
      append(`[test ${side}] ERROR: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setTestBusy(false);
    }
  };

  const fireSyntheticSignal = async (side: "entry" | "exit"): Promise<void> => {
    setTestBusy(true);
    try {
      const exec = buildJupiterExecutionAdapter();
      const payload = {
        barIndex: -1,
        timeMs: Date.now(),
        reason: `UI_TEST_${side.toUpperCase()}`,
      };
      if (side === "entry") {
        await exec.onSignalEntry(payload);
      } else {
        await exec.onSignalExit(payload);
      }
      append(`[test signal ${side}] Jupiter leg finished for ${payload.reason}`);
    } catch (e) {
      append(`[test signal ${side}] ERROR: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setTestBusy(false);
    }
  };

  return (
    <div className="panel">
      <h2 style={{ fontSize: "1.05rem", margin: "0 0 8px" }}>Signal automation bot</h2>
      <p className="hint" style={{ fontSize: 12, marginTop: 0 }}>
        <strong>Automation</strong> (session keypair): enable permission and paste a <strong>base58 secret</strong> or JSON
        <code>[u8×64]</code> — stored <strong>only in memory</strong> until you refresh or disable permission. <strong>Manual</strong>: connect
        Phantom; each swap opens the wallet prompt. If automation permission is on but the key is invalid, the app <strong>does not</strong>{" "}
        fall back to Phantom (explicit fail). Poll uses GeckoTerminal OHLCV (same pool id as chart-web).
      </p>

      <label htmlFor="bot-pool">GeckoTerminal pool address (Solana)</label>
      <input
        id="bot-pool"
        type="text"
        spellCheck={false}
        value={poolAddress}
        onChange={(e) => setPoolAddress(e.target.value)}
        disabled={running}
      />

      <label htmlFor="bot-poll">Poll interval (ms, min 5000)</label>
      <input
        id="bot-poll"
        type="text"
        inputMode="numeric"
        value={pollMsStr}
        onChange={(e) => setPollMsStr(e.target.value)}
        disabled={running}
      />

      <div className="row" style={{ marginTop: 10 }}>
        <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
          <input
            type="checkbox"
            checked={automationPermission}
            onChange={(e) => setAutomationPermission(e.target.checked)}
            disabled={running || envKillSwitch}
          />
          I grant this site permission to sign swaps automatically using the session secret below (hot wallet risk)
        </label>
      </div>

      <label htmlFor="bot-secret">Session secret key (only if automation permission is on)</label>
      <textarea
        id="bot-secret"
        rows={2}
        spellCheck={false}
        autoComplete="off"
        placeholder="Base58 or [byte,…] JSON — never commit or share"
        value={automationSecret}
        onChange={(e) => setAutomationSecret(e.target.value)}
        disabled={!automationPermission || running}
        style={{
          width: "100%",
          padding: "8px 10px",
          borderRadius: 8,
          border: "1px solid #2b3139",
          background: "#181a20",
          color: "inherit",
          fontFamily: "ui-monospace, monospace",
          fontSize: 12,
        }}
      />

      <div className="row" style={{ marginTop: 12 }}>
        {!running ? (
          <button type="button" className="action" onClick={startBot}>
            Start signal bot
          </button>
        ) : (
          <button type="button" className="action danger" onClick={stopBot}>
            Stop signal bot
          </button>
        )}
      </div>

      <hr style={{ border: "none", borderTop: "1px solid #2b3139", margin: "16px 0" }} />

      <div style={{ fontWeight: 600, marginBottom: 6 }}>Tester — Jupiter legs (same amounts as manual section)</div>
      <p className="hint" style={{ fontSize: 11, marginTop: 0 }}>
        Uses BUY lamports / SELL raw / slippage / mint from the form above. Respects Simulate only and{" "}
        <code>VITE_MODE</code> broadcast rules.
      </p>
      <div className="row">
        <button type="button" className="action" disabled={testBusy} onClick={() => void runTestLeg("buy")}>
          Test BUY (SOL → mint)
        </button>
        <button type="button" className="action danger" disabled={testBusy} onClick={() => void runTestLeg("sell")}>
          Test SELL (mint → SOL)
        </button>
      </div>
      <div className="row" style={{ marginTop: 8 }}>
        <button type="button" className="action" disabled={testBusy} onClick={() => void fireSyntheticSignal("entry")}>
          Test SIGNAL_ENTRY → Jupiter BUY
        </button>
        <button type="button" className="action danger" disabled={testBusy} onClick={() => void fireSyntheticSignal("exit")}>
          Test SIGNAL_EXIT → Jupiter SELL
        </button>
      </div>
    </div>
  );
}
