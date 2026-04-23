import { Connection, PublicKey } from "@solana/web3.js";

/** Sum raw token amount across the owner's token accounts for `mint` (no decimals). */
export async function readWalletSplTokenBalanceRaw(
  connection: Connection,
  owner: PublicKey,
  mintBase58: string,
): Promise<bigint> {
  const mint = new PublicKey(mintBase58);
  const res = await connection.getParsedTokenAccountsByOwner(owner, { mint });
  let total = 0n;
  for (const row of res.value) {
    const parsed = row.account.data.parsed;
    if (parsed && typeof parsed === "object" && "info" in parsed) {
      const info = (parsed as { info?: { tokenAmount?: { amount?: string } } }).info;
      const amt = info?.tokenAmount?.amount;
      if (typeof amt === "string" && /^\d+$/.test(amt)) {
        total += BigInt(amt);
      }
    }
  }
  return total;
}
