/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_RPC_URL?: string;
  readonly VITE_TOKEN_MINT?: string;
  readonly VITE_SOL_BOT_MAX_INPUT_RAW?: string;
  readonly VITE_MODE?: string;
  readonly VITE_SOL_BOT_KILL_SWITCH?: string;
  /** Override Jupiter Swap API v1 root (default: proxied `/jupiter-api` locally, else https://api.jup.ag/swap/v1). */
  readonly VITE_JUPITER_API_BASE?: string;
  /** Lamports spent per automated SIGNAL_ENTRY (ExactIn: SOL → x_token, default 1_000_000 = 0.001 SOL). */
  readonly VITE_SIGNAL_BUY_LAMPORTS?: string;
  /** Lamports of SOL to receive on SIGNAL_EXIT (ExactOut: x_token → SOL; default = buy or 1_000_000 = 0.001 SOL). */
  readonly VITE_SIGNAL_SELL_OUT_LAMPORTS?: string;
  readonly VITE_SIGNAL_SLIPPAGE_BPS?: string;
  /**
   * Hot-wallet secret for automated strategy swaps (base58 or JSON byte array; same as Phantom export).
   * Embedded in the client bundle by Vite — not for production secrets you must hide from users.
   */
  readonly VITE_DESK_PRIVATE_KEY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
