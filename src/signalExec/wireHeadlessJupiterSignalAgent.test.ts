import { Keypair } from "@solana/web3.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BarIndicators } from "../strategy/barIndicators.js";
import type { Ohlcv } from "../strategy/candleSemantics.js";
import { DEFAULT_STRATEGY_CONFIG } from "../strategy/strategyConfig.js";
import { loadBotEnv } from "../config/botEnv.js";
import * as swapExecutor from "../execution/swapExecutor.js";
import { loadHeadlessSignalExecConfig } from "./headlessSignalEnv.js";
import { assertHeadlessExecPolicy, createHeadlessJupiterSignalAgent } from "./wireHeadlessJupiterSignalAgent.js";

function bar(o: number, h: number, l: number, c: number, t: number, v = 1): Ohlcv {
  return { open: o, high: h, low: l, close: c, volume: v, timeMs: t };
}

describe("createHeadlessJupiterSignalAgent", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("invokes executeJupiterSwap on tail ENTRY+EXIT once per tick; dedupes on repeat tick", async () => {
    const spy = vi.spyOn(swapExecutor, "executeJupiterSwap").mockResolvedValue({
      quote: {},
      simulation: { value: { err: null, logs: [] }, context: { slot: 1 } },
    });

    const bot = loadBotEnv({
      MODE: "live",
      RPC_URL: "https://api.mainnet-beta.solana.com",
      TOKEN_MINT: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      SOL_BOT_MAX_INPUT_RAW: "5000000",
      SOL_BOT_KILL_SWITCH: "0",
      SIGNING_MODE: "headless_dev",
    } as NodeJS.ProcessEnv);

    const exec = loadHeadlessSignalExecConfig({
      SIGNAL_EXEC_POOL_ADDRESS: "dummy",
      SIGNAL_EXEC_BUY_LAMPORTS: "1000000",
      SIGNAL_EXEC_SELL_TOKEN_RAW: "10000",
      SIGNAL_EXEC_SIMULATE_ONLY: "1",
    } as NodeJS.ProcessEnv);

    const fixtureIndicators: BarIndicators[] = [
      { vwap: 10, vwma3: 1, vwma9: 2, vwma18: 4 },
      { vwap: 10, vwma3: 1, vwma9: 2, vwma18: 4 },
      { vwap: 10, vwma3: 3, vwma9: 2, vwma18: 4 },
      { vwap: 8, vwma3: 4, vwma9: 3, vwma18: 4 },
      { vwap: 8, vwma3: 5, vwma9: 4, vwma18: 4 },
      { vwap: 8, vwma3: 5, vwma9: 3, vwma18: 4 },
    ];
    const bars: Ohlcv[] = [
      bar(1, 2, 1, 1, 1_000),
      bar(1, 2, 1, 1, 2_000),
      bar(1, 6, 1, 5, 3_000),
      bar(7, 10, 6, 9, 4_000),
      bar(8, 11, 7, 10, 5_000),
      bar(8, 11, 7, 10, 6_000),
    ];

    const conn = {
      getLatestBlockhash: vi.fn().mockResolvedValue({ blockhash: "11111111111111111111111111111111", lastValidBlockHeight: 99 }),
    };

    const kp = Keypair.generate();
    const agent = createHeadlessJupiterSignalAgent(bot, exec, {
      connection: conn as never,
      keypair: kp,
      fetchBars: async () => bars,
      strategy: DEFAULT_STRATEGY_CONFIG,
      computeIndicators: (barsIn) => {
        expect(barsIn.length).toBe(fixtureIndicators.length);
        return fixtureIndicators;
      },
      executionTailBarLookback: 3,
      log: () => {},
    });

    const r1 = await agent.runTick(async () => bars);
    expect(r1.ok).toBe(true);
    const r2 = await agent.runTick(async () => bars);
    expect(r2.ok).toBe(true);

    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("rejects live sends when MODE is not live", () => {
    const bot = loadBotEnv({
      MODE: "paper",
      RPC_URL: "https://api.mainnet-beta.solana.com",
      TOKEN_MINT: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      SOL_BOT_MAX_INPUT_RAW: "5000000",
      SOL_BOT_KILL_SWITCH: "0",
    } as NodeJS.ProcessEnv);
    const exec = loadHeadlessSignalExecConfig({
      SIGNAL_EXEC_POOL_ADDRESS: "p",
      SIGNAL_EXEC_SIMULATE_ONLY: "0",
    } as NodeJS.ProcessEnv);
    expect(() => assertHeadlessExecPolicy(bot, exec)).toThrow(/MODE=live/);
  });
});
