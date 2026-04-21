/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_RPC_URL?: string;
  readonly VITE_TOKEN_MINT?: string;
  readonly VITE_SOL_BOT_MAX_INPUT_RAW?: string;
  readonly VITE_MODE?: string;
  readonly VITE_SOL_BOT_KILL_SWITCH?: string;
  /** Override Jupiter Swap API v1 root (default: proxied `/jupiter-api` locally, else https://api.jup.ag/swap/v1). */
  readonly VITE_JUPITER_API_BASE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
