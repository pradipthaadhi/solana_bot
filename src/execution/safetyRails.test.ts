import { describe, expect, it } from "vitest";
import { assertSwapSafety, assertTradingAllowed, assertWithinMaxInput } from "./safetyRails.js";

describe("assertTradingAllowed", () => {
  it("throws when kill switch is engaged", () => {
    expect(() => assertTradingAllowed({ killSwitchEngaged: true, maxInputRaw: 1n })).toThrow(/KILL_SWITCH/);
  });
});

describe("assertWithinMaxInput", () => {
  it("throws when above cap", () => {
    expect(() => assertWithinMaxInput(101n, 100n)).toThrow(/MAX_INPUT_EXCEEDED/);
  });
});

describe("assertSwapSafety (Stage 5.5)", () => {
  it("throws when quoted input exceeds cap", () => {
    expect(() =>
      assertSwapSafety({
        rails: { killSwitchEngaged: false, maxInputRaw: 100n },
        quotedInputRaw: 101n,
      }),
    ).toThrow(/MAX_INPUT_EXCEEDED/);
  });

  it("throws on non-positive input", () => {
    expect(() =>
      assertSwapSafety({
        rails: { killSwitchEngaged: false, maxInputRaw: 100n },
        quotedInputRaw: 0n,
      }),
    ).toThrow(/INVALID_AMOUNT/);
  });

  it("passes when within cap and switch off", () => {
    expect(() =>
      assertSwapSafety({
        rails: { killSwitchEngaged: false, maxInputRaw: 500n },
        quotedInputRaw: 500n,
      }),
    ).not.toThrow();
  });
});
