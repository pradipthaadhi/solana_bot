import { Keypair, VersionedTransaction } from "@solana/web3.js";
import bs58 from "bs58";
import { describe, expect, it } from "vitest";
import type { SignVersionedTransaction } from "../execution/types.js";
import { resolveTraderSigning, signingMaterialFromResolved } from "./resolveTraderSigning.js";

describe("resolveTraderSigning", () => {
  const passThroughSign: SignVersionedTransaction = async (tx: VersionedTransaction) => tx;

  it("prefers automation when permission is granted and secret is valid", () => {
    const kp = Keypair.generate();
    const r = resolveTraderSigning({
      automationPermissionGranted: true,
      automationSecretText: bs58.encode(kp.secretKey),
      walletConnected: true,
      walletSignTransaction: passThroughSign,
      walletPublicKey: Keypair.generate().publicKey,
    });
    expect(r.kind).toBe("automation");
    if (r.kind === "automation") {
      expect(r.keypair.publicKey.toBase58()).toBe(kp.publicKey.toBase58());
    }
  });

  it("does not fall back to wallet when permission is on but secret is invalid", () => {
    const r = resolveTraderSigning({
      automationPermissionGranted: true,
      automationSecretText: "not-a-real-key",
      walletConnected: true,
      walletSignTransaction: passThroughSign,
      walletPublicKey: Keypair.generate().publicKey,
    });
    expect(r.kind).toBe("none");
  });

  it("uses manual wallet when automation permission is off and wallet is connected", () => {
    const pk = Keypair.generate().publicKey;
    const sign: SignVersionedTransaction = async (tx: VersionedTransaction) => tx;
    const r = resolveTraderSigning({
      automationPermissionGranted: false,
      automationSecretText: "",
      walletConnected: true,
      walletSignTransaction: sign,
      walletPublicKey: pk,
    });
    expect(r.kind).toBe("manual_wallet");
  });

  it("signingMaterialFromResolved returns signer for automation", async () => {
    const kp = Keypair.generate();
    const mat = signingMaterialFromResolved({
      kind: "automation",
      keypair: kp,
    });
    expect(mat).not.toBeNull();
    expect(mat!.userPublicKeyBase58).toBe(kp.publicKey.toBase58());
  });
});
