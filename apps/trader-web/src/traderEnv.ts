/**
 * Stage 6 — browser-side env for trader-web (Vite `import.meta.env`, not `process.env`).
 * Mirrors server keys from `src/config/botEnv.ts` with a `VITE_` prefix where applicable.
 */

import type { OperationalMode } from "@bot/scope/stage0.js";
import { DEFAULT_OPERATIONAL_MODE } from "@bot/scope/stage0.js";

function trimUndef(v: string | undefined): string | undefined {
  const t = v?.trim();
  return t && t.length > 0 ? t : undefined;
}

function parseBool01(raw: string | undefined): boolean {
  const v = raw?.trim().toLowerCase();
  return v === "1" || v === "true";
}

function parseOperationalMode(raw: string | undefined): OperationalMode {
  const s = raw?.trim().toLowerCase();
  if (!s) {
    return DEFAULT_OPERATIONAL_MODE;
  }
  if (s === "replay" || s === "paper" || s === "live") {
    return s;
  }
  if (import.meta.env.DEV) {
    console.warn(`[trader-web] Invalid VITE_MODE=${JSON.stringify(raw)}; using ${DEFAULT_OPERATIONAL_MODE}`);
  }
  return DEFAULT_OPERATIONAL_MODE;
}

export interface TraderViteEnv {
  operationalMode: OperationalMode;
  envKillSwitch: boolean;
  defaultRpc: string | undefined;
  defaultTokenMint: string | undefined;
  defaultMaxInputRaw: bigint | undefined;
}

export function readTraderViteEnv(): TraderViteEnv {
  const maxRaw = trimUndef(import.meta.env.VITE_SOL_BOT_MAX_INPUT_RAW as string | undefined);
  let defaultMaxInputRaw: bigint | undefined;
  if (maxRaw) {
    try {
      defaultMaxInputRaw = BigInt(maxRaw);
    } catch {
      if (import.meta.env.DEV) {
        console.warn("[trader-web] Invalid VITE_SOL_BOT_MAX_INPUT_RAW ignored");
      }
    }
  }

  return {
    operationalMode: parseOperationalMode(import.meta.env.VITE_MODE as string | undefined),
    envKillSwitch: parseBool01(import.meta.env.VITE_SOL_BOT_KILL_SWITCH as string | undefined),
    defaultRpc: trimUndef(import.meta.env.VITE_RPC_URL as string | undefined),
    defaultTokenMint: trimUndef(import.meta.env.VITE_TOKEN_MINT as string | undefined),
    defaultMaxInputRaw,
  };
}
