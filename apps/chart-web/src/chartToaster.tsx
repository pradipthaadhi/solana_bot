/**
 * Single {@link Toaster} mount for the vanilla chart app + imperative helpers (strategy signals).
 */

import { createRoot } from "react-dom/client";
import toast, { Toaster, type Toast } from "react-hot-toast";

let mounted = false;

const ACCENT_BUY = "#26a69a";
const ACCENT_SELL = "#ef5350";
const ACCENT_NEUTRAL = "#6b7c8f";
const ACCENT_ERR = "#e57373";
const ACCENT_WALLET = "#14f195";

function ToastCard({ t, title, body, accent }: { t: Toast; title: string; body: string; accent: string }) {
  return (
    <div
      style={{
        opacity: t.visible ? 1 : 0,
        transform: t.visible ? "translateY(0) scale(1)" : "translateY(6px) scale(0.98)",
        transition: "opacity 0.2s ease, transform 0.2s ease",
        display: "flex",
        gap: 12,
        alignItems: "stretch",
        minWidth: 0,
        width: "100%",
      }}
    >
      <div style={{ width: 4, borderRadius: 4, background: accent, flexShrink: 0 }} aria-hidden />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: 700, fontSize: 14, letterSpacing: "0.04em", color: "#f0f3f6" }}>{title}</div>
        <div
          style={{
            marginTop: 6,
            fontSize: 12,
            lineHeight: 1.5,
            color: "rgba(232, 234, 237, 0.9)",
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
          }}
        >
          {body}
        </div>
      </div>
    </div>
  );
}

function pushCard(title: string, body: string, accent: string, duration: number): void {
  toast.custom((t) => <ToastCard t={t} title={title} body={body} accent={accent} />, {
    duration,
    ariaProps: { role: "status", "aria-live": "polite" },
  });
}

/** Idempotent: safe to call on every chart mount. */
export function mountChartToaster(): void {
  if (typeof document === "undefined") {
    return;
  }
  if (mounted || document.getElementById("chart-toaster-root")) {
    mounted = true;
    return;
  }
  const host = document.createElement("div");
  host.id = "chart-toaster-root";
  document.body.appendChild(host);
  createRoot(host).render(
    <Toaster
      position="top-right"
      gutter={10}
      reverseOrder={false}
      containerStyle={{ top: 20, right: 20 }}
      toastOptions={{
        duration: 12_000,
        style: {
          background: "#171c24",
          color: "#e8eaed",
          border: "1px solid #2b3139",
          borderRadius: 14,
          padding: "2px 4px",
          boxShadow: "0 10px 28px rgba(0,0,0,0.45)",
          maxWidth: "min(420px, calc(100vw - 32px))",
        },
      }}
    />
  );
  mounted = true;
}

/** After position log write completes for a strategy BUY. */
export function chartToastBuySignalDone(pairLabel: string, reason: string, timeIso: string): void {
  pushCard(
    `${pairLabel} — BUY`,
    `${reason}\n${timeIso}\nLogged to signal history.`,
    ACCENT_BUY,
    16_000,
  );
}

/** After position log write completes for a strategy SELL. */
export function chartToastSellSignalDone(pairLabel: string, reason: string, timeIso: string): void {
  pushCard(
    `${pairLabel} — SELL`,
    `${reason}\n${timeIso}\nLogged to signal history.`,
    ACCENT_SELL,
    16_000,
  );
}

export function chartToastStrategyTail(pairLabel: string, kind: string, reason: string, timeIso: string, duration = 9000): void {
  pushCard(`${pairLabel} — ${kind}`, `${reason}\n${timeIso}`, ACCENT_NEUTRAL, duration);
}

export function chartToastInfo(title: string, body: string, duration = 14_000): void {
  pushCard(title, body, ACCENT_NEUTRAL, duration);
}

export function chartToastError(title: string, body: string, duration = 9000): void {
  pushCard(title, body, ACCENT_ERR, duration);
}

export function chartToastSwapDone(
  leg: "BUY" | "SELL",
  mode: "simulate" | "broadcast",
  detail: string,
  duration?: number,
): void {
  const accent = leg === "BUY" ? ACCENT_BUY : ACCENT_SELL;
  const title = `${leg} ${mode === "simulate" ? "simulated" : "complete"}`;
  pushCard(title, detail, accent, duration ?? (mode === "broadcast" ? 18_000 : 10_000));
}

export function chartToastWalletConnected(addressBase58: string, detail?: string): void {
  const short = `${addressBase58.slice(0, 4)}…${addressBase58.slice(-4)}`;
  pushCard(
    "Phantom connected",
    detail ? `${short}\n${detail}` : `${short}\nReady to quote and sign swaps.`,
    ACCENT_WALLET,
    12_000,
  );
}

export function chartToastWalletConnectFailed(message: string): void {
  pushCard("Wallet not connected", message, ACCENT_ERR, 14_000);
}

export function chartToastWalletAccountSwitched(addressBase58: string): void {
  const short = `${addressBase58.slice(0, 4)}…${addressBase58.slice(-4)}`;
  pushCard("Active account", short, ACCENT_NEUTRAL, 6000);
}
