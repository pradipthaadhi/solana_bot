/**
 * @solana/web3.js and some bundled paths expect `Buffer` in the browser bundle.
 */
import { Buffer } from "buffer";

const g = globalThis as typeof globalThis & { Buffer?: typeof Buffer };
if (g.Buffer === undefined) {
  g.Buffer = Buffer;
}
