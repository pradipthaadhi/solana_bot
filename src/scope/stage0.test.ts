import { describe, expect, it } from "vitest";
import { DEFAULT_OPERATIONAL_MODE, DONE_CRITERIA, POC_IN_SCOPE, POC_OUT_OF_SCOPE } from "./stage0.js";

describe("Stage 0 scope constants", () => {
  it("lists in-scope pillars", () => {
    expect(POC_IN_SCOPE.length).toBeGreaterThanOrEqual(4);
    expect(POC_IN_SCOPE.some((s) => s.includes("CoinGecko"))).toBe(true);
  });

  it("lists explicit non-goals", () => {
    expect(POC_OUT_OF_SCOPE.some((s) => s.includes("MEV"))).toBe(true);
  });

  it("pins done criteria ids", () => {
    expect(Object.keys(DONE_CRITERIA)).toEqual(["offline_replay", "live_paper", "live_tiny"]);
  });

  it("defaults operational mode to paper", () => {
    expect(DEFAULT_OPERATIONAL_MODE).toBe("paper");
  });
});
