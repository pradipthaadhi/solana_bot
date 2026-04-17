import { describe, expect, it } from "vitest";
import { buildSafetyRailsFromBotEnv, loadBotEnv, redactBotEnv } from "./botEnv.js";

describe("loadBotEnv (Stage 6)", () => {
  it("applies defaults", () => {
    const e = loadBotEnv({});
    expect(e.mode).toBe("paper");
    expect(e.signingMode).toBe("phantom_ui");
    expect(e.coingeckoVsCurrency).toBe("usd");
    expect(e.coingeckoOhlcDays).toBe(1);
    expect(e.rpcUrl).toContain("mainnet");
    expect(e.quoteMint).toContain("111");
  });

  it("parses MODE and SIGNING_MODE case-insensitively", () => {
    const e = loadBotEnv({
      MODE: "LIVE",
      SIGNING_MODE: "HEADLESS_DEV",
      COINGECKO_OHLC_DAYS: "2",
    });
    expect(e.mode).toBe("live");
    expect(e.signingMode).toBe("headless_dev");
    expect(e.coingeckoOhlcDays).toBe(2);
  });

  it("throws on invalid MODE", () => {
    expect(() => loadBotEnv({ MODE: "prod" })).toThrow(/MODE must/);
  });

  it("throws on invalid OHLC days", () => {
    expect(() => loadBotEnv({ COINGECKO_OHLC_DAYS: "7" })).toThrow(/COINGECKO_OHLC_DAYS/);
  });

  it("redactBotEnv is JSON-safe", () => {
    const r = redactBotEnv(
      loadBotEnv({
        TOKEN_MINT: "So11111111111111111111111111111111111111112",
        SOL_BOT_MAX_INPUT_RAW: "25000",
      }),
    );
    expect(r.tokenMint).toBeTruthy();
    expect(r.solBotMaxInputRaw).toBe("25000");
  });
});

describe("buildSafetyRailsFromBotEnv", () => {
  it("maps kill switch and max input", () => {
    const rails = buildSafetyRailsFromBotEnv(
      loadBotEnv({
        SOL_BOT_KILL_SWITCH: "1",
        SOL_BOT_MAX_INPUT_RAW: "123",
        MODE: "replay",
      }),
    );
    expect(rails.killSwitchEngaged).toBe(true);
    expect(rails.maxInputRaw).toBe(123n);
    expect(rails.operationalMode).toBe("replay");
  });

  it("override max wins", () => {
    const rails = buildSafetyRailsFromBotEnv(loadBotEnv({}), { maxInputRaw: 99n });
    expect(rails.maxInputRaw).toBe(99n);
  });
});
