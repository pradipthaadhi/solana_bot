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
      }),
    );
    expect(r.tokenMint).toBeTruthy();
  });
});

describe("buildSafetyRailsFromBotEnv", () => {
  it("maps kill switch and mode", () => {
    const rails = buildSafetyRailsFromBotEnv(
      loadBotEnv({
        SOL_BOT_KILL_SWITCH: "1",
        MODE: "replay",
      }),
    );
    expect(rails.killSwitchEngaged).toBe(true);
    expect(rails.operationalMode).toBe("replay");
  });

  it("override kill switch wins", () => {
    const rails = buildSafetyRailsFromBotEnv(loadBotEnv({}), { killSwitchEngaged: true });
    expect(rails.killSwitchEngaged).toBe(true);
  });
});
