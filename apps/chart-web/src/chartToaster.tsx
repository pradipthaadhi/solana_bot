/**
 * Single {@link Toaster} mount for the vanilla chart app + imperative helpers (strategy signals).
 */

import { createRoot } from "react-dom/client";
import toast, { Toaster, type Toast } from "react-hot-toast";

let mounted = false;

/** All chart toasts auto-dismiss after 1.5s. */
const TOAST_DURATION_MS = 1500;

const ACCENT_BUY = "#2dd4bf";
const ACCENT_SELL = "#fb7185";
const ACCENT_NEUTRAL = "#94a3b8";
const ACCENT_ERR = "#f87171";
const ACCENT_WALLET = "#34d399";

function ToastCard({ t, title, body, accent }: { t: Toast; title: string; body: string; accent: string }) {
  return (
    <div
      className="chart-toast-surface"
      style={{
        opacity: t.visible ? 1 : 0,
        transform: t.visible ? "translate3d(0,0,0) scale(1)" : "translate3d(0,-10px,0) scale(0.97)",
        transition: "opacity 0.22s cubic-bezier(0.22, 1, 0.36, 1), transform 0.28s cubic-bezier(0.34, 1.56, 0.64, 1)",
      }}
    >
      <div className="chart-toast-accent" style={{ background: accent, boxShadow: `0 0 20px 2px ${accent}30` }} aria-hidden />
      <div className="chart-toast-body-wrap">
        <div className="chart-toast-title">{title}</div>
        <div className="chart-toast-body">{body}</div>
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
      gutter={12}
      reverseOrder={false}
      containerStyle={{ top: 24, right: 20, zIndex: 20050 }}
      toastOptions={{
        duration: TOAST_DURATION_MS,
        className: "chart-toast-host",
        style: {
          background: "transparent",
          boxShadow: "none",
          border: "none",
          padding: 0,
          maxWidth: "min(22rem, calc(100vw - 2rem))",
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
    TOAST_DURATION_MS,
  );
}

/** After position log write completes for a strategy SELL. */
export function chartToastSellSignalDone(pairLabel: string, reason: string, timeIso: string): void {
  pushCard(
    `${pairLabel} — SELL`,
    `${reason}\n${timeIso}\nLogged to signal history.`,
    ACCENT_SELL,
    TOAST_DURATION_MS,
  );
}

export function chartToastStrategyTail(pairLabel: string, kind: string, reason: string, timeIso: string, duration = TOAST_DURATION_MS): void {
  pushCard(`${pairLabel} — ${kind}`, `${reason}\n${timeIso}`, ACCENT_NEUTRAL, duration);
}

export function chartToastInfo(title: string, body: string, duration = TOAST_DURATION_MS): void {
  pushCard(title, body, ACCENT_NEUTRAL, duration);
}

export function chartToastError(title: string, body: string, duration = TOAST_DURATION_MS): void {
  pushCard(title, body, ACCENT_ERR, duration);
}

export function chartToastSwapDone(
  leg: "BUY" | "SELL",
  mode: "simulate" | "broadcast",
  detail: string,
  duration: number = TOAST_DURATION_MS,
): void {
  const accent = leg === "BUY" ? ACCENT_BUY : ACCENT_SELL;
  const title = `${leg} ${mode === "simulate" ? "simulated" : "complete"}`;
  pushCard(title, detail, accent, duration);
}

export function chartToastWalletConnected(addressBase58: string, detail?: string): void {
  const short = `${addressBase58.slice(0, 4)}…${addressBase58.slice(-4)}`;
  pushCard(
    "Phantom connected",
    detail ? `${short}\n${detail}` : `${short}\nReady to quote and sign swaps.`,
    ACCENT_WALLET,
    TOAST_DURATION_MS,
  );
}

export function chartToastWalletConnectFailed(message: string): void {
  pushCard("Wallet not connected", message, ACCENT_ERR, TOAST_DURATION_MS);
}

export function chartToastWalletAccountSwitched(addressBase58: string): void {
  const short = `${addressBase58.slice(0, 4)}…${addressBase58.slice(-4)}`;
  pushCard("Active account", short, ACCENT_NEUTRAL, TOAST_DURATION_MS);
}
