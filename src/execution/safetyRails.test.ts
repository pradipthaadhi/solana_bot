import { describe, expect, it } from "vitest";
import { assertOnChainBroadcastAllowed, assertTradingAllowed } from "./safetyRails.js";

describe("assertTradingAllowed", () => {
  it("throws when kill switch is engaged", () => {
    expect(() => assertTradingAllowed({ killSwitchEngaged: true, maxInputRaw: 1n })).toThrow(/KILL_SWITCH/);
  });
});

describe("assertOnChainBroadcastAllowed (Stage 6)", () => {
  it("allows broadcast when mode is live or unset", () => {
    expect(() => assertOnChainBroadcastAllowed({ killSwitchEngaged: false, maxInputRaw: 1n, operationalMode: "live" }, true)).not.toThrow();
    expect(() => assertOnChainBroadcastAllowed({ killSwitchEngaged: false, maxInputRaw: 1n }, true)).not.toThrow();
  });

  it("allows paper when not broadcasting", () => {
    expect(() => assertOnChainBroadcastAllowed({ killSwitchEngaged: false, maxInputRaw: 1n, operationalMode: "paper" }, false)).not.toThrow();
  });

  it("blocks paper/replay when broadcasting", () => {
    expect(() => assertOnChainBroadcastAllowed({ killSwitchEngaged: false, maxInputRaw: 1n, operationalMode: "paper" }, true)).toThrow(
      /MODE_PAPER/,
    );
    expect(() => assertOnChainBroadcastAllowed({ killSwitchEngaged: false, maxInputRaw: 1n, operationalMode: "replay" }, true)).toThrow(
      /MODE_REPLAY/,
    );
  });
});
