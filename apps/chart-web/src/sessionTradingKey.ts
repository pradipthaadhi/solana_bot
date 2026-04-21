import type { Keypair } from "@solana/web3.js";

let sessionKeypair: Keypair | null = null;

export function setSessionTradingKeypair(kp: Keypair): void {
  sessionKeypair = kp;
}

export function getSessionTradingKeypair(): Keypair | null {
  return sessionKeypair;
}

export function clearSessionTradingKeypair(): void {
  sessionKeypair = null;
}
