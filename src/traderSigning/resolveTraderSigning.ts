/**
 * Choose **automation** (session keypair) vs **manual** (wallet adapter) signing for browser bots.
 * Automation wins only when the user explicitly grants permission **and** supplies a parseable key.
 */

import type { Keypair, PublicKey } from "@solana/web3.js";
import { createKeypairSigner } from "../execution/keypairSigner.js";
import type { SignVersionedTransaction } from "../execution/types.js";
import { parseSessionSecretKey } from "./parseSessionSecretKey.js";

export type ResolvedTraderSigning =
  | { kind: "automation"; keypair: Keypair }
  | {
      kind: "manual_wallet";
      publicKey: PublicKey;
      signTransaction: SignVersionedTransaction;
    }
  | { kind: "none"; reason: string };

export interface ResolveTraderSigningInput {
  /** User explicitly allows loading a session secret for unattended signing. */
  automationPermissionGranted: boolean;
  /** Raw textarea content (base58 or JSON array). */
  automationSecretText: string;
  walletConnected: boolean;
  walletSignTransaction: SignVersionedTransaction | undefined;
  walletPublicKey: PublicKey | undefined;
}

/**
 * - If `automationPermissionGranted` is true, **only** a valid pasted secret is accepted (no silent fallback to Phantom).
 * - If permission is false, Phantom (or any connected wallet) is used when connected.
 */
export function resolveTraderSigning(input: ResolveTraderSigningInput): ResolvedTraderSigning {
  if (input.automationPermissionGranted) {
    const t = input.automationSecretText.trim();
    if (t.length === 0) {
      return {
        kind: "none",
        reason: "Automation permission is on: paste a valid session secret key (base58 or JSON byte array).",
      };
    }
    try {
      return { kind: "automation", keypair: parseSessionSecretKey(t) };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { kind: "none", reason: msg };
    }
  }

  if (input.walletConnected && input.walletSignTransaction !== undefined && input.walletPublicKey !== undefined) {
    return {
      kind: "manual_wallet",
      publicKey: input.walletPublicKey,
      signTransaction: input.walletSignTransaction,
    };
  }

  return {
    kind: "none",
    reason: "Connect a wallet (e.g. Phantom) or enable automation permission and paste a session secret key.",
  };
}

/** Signer + owner pubkey string for Jupiter swap construction. */
export interface SigningMaterial {
  userPublicKeyBase58: string;
  signTransaction: SignVersionedTransaction;
}

export function signingMaterialFromResolved(r: ResolvedTraderSigning): SigningMaterial | null {
  if (r.kind === "automation") {
    const kp = r.keypair;
    return {
      userPublicKeyBase58: kp.publicKey.toBase58(),
      signTransaction: createKeypairSigner(kp),
    };
  }
  if (r.kind === "manual_wallet") {
    const sign = r.signTransaction;
    return {
      userPublicKeyBase58: r.publicKey.toBase58(),
      signTransaction: async (tx) => sign(tx),
    };
  }
  return null;
}
