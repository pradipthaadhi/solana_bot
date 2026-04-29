import { describe, expect, it } from "vitest";
import { assertValidStrategyConfig, DEFAULT_STRATEGY_CONFIG } from "./strategyConfig.js";

describe("assertValidStrategyConfig — vwmaPeriods", () => {
  it("accepts defaults", () => {
    expect(() => assertValidStrategyConfig(DEFAULT_STRATEGY_CONFIG)).not.toThrow();
  });

  it("rejects non-increasing periods", () => {
    expect(() =>
      assertValidStrategyConfig({
        ...DEFAULT_STRATEGY_CONFIG,
        vwmaPeriods: { fast: 9, mid: 3, slow: 18 },
      }),
    ).toThrow(/fast < mid < slow/);
  });
});
