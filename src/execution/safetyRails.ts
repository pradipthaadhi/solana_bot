import type { SafetyRails } from "./types.js";

export interface SafetyAssertionInput {
  rails: SafetyRails;
  /** Parsed `inAmount` from Jupiter quote (ExactIn). */
  quotedInputRaw: bigint;
}

/** Block all outbound swap work (must run before any HTTP/RPC to Jupiter or RPC). */
export function assertTradingAllowed(rails: SafetyRails): void {
  if (rails.killSwitchEngaged) {
    throw new Error("KILL_SWITCH: trading halted by configuration (SOL_BOT_KILL_SWITCH=1).");
  }
}

export function assertWithinMaxInput(quotedInputRaw: bigint, maxInputRaw: bigint): void {
  if (quotedInputRaw <= 0n) {
    throw new Error("INVALID_AMOUNT: quoted input must be positive.");
  }
  if (quotedInputRaw > maxInputRaw) {
    throw new Error(
      `MAX_INPUT_EXCEEDED: quoted input ${quotedInputRaw.toString()} exceeds cap ${maxInputRaw.toString()} (lamports or raw token units).`,
    );
  }
}

/**
 * Stage 5.5 — full safety check (kill switch + cap).
 */
export function assertSwapSafety(input: SafetyAssertionInput): void {
  assertTradingAllowed(input.rails);
  assertWithinMaxInput(input.quotedInputRaw, input.rails.maxInputRaw);
}
