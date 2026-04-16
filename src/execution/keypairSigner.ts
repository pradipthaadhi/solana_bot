import type { Keypair, VersionedTransaction } from "@solana/web3.js";
import type { SignVersionedTransaction } from "./types.js";

/** Model B — sign with an in-process keypair (hot wallet; dev / automation only). */
export function createKeypairSigner(keypair: Keypair): SignVersionedTransaction {
  return async (tx: VersionedTransaction) => {
    tx.sign([keypair]);
    return tx;
  };
}
