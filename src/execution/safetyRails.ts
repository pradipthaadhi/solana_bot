import type { SafetyRails } from "./types.js";

/** Stage 6 — block mainnet broadcast outside `MODE=live`. */
export function assertOnChainBroadcastAllowed(rails: SafetyRails, willBroadcast: boolean): void {
  if (!willBroadcast) {
    return;
  }
  const mode = rails.operationalMode;
  if (mode === undefined || mode === "live") {
    return;
  }
  throw new Error(
    `MODE_${mode.toUpperCase()}: on-chain broadcast is disabled. Set MODE=live (after explicit review) or use simulateOnly / broadcast:false.`,
  );
}

/** Block all outbound swap work (must run before any HTTP/RPC to Jupiter or RPC). */
export function assertTradingAllowed(rails: SafetyRails): void {
  if (rails.killSwitchEngaged) {
    throw new Error("KILL_SWITCH: trading halted by configuration (SOL_BOT_KILL_SWITCH=1).");
  }
}
