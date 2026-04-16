import { describe, expect, it } from "vitest";
import { geckoOhlcvListToBars, parseGeckoTerminalOhlcvJson } from "./geckoTerminalOhlcv.js";

describe("geckoTerminalOhlcv", () => {
  it("parses ohlcv_list rows and sorts ascending by open time", () => {
    const rows = [
      [200, 2, 2, 2, 2, 10],
      [100, 1, 1, 1, 1, 5],
    ];
    const bars = geckoOhlcvListToBars(rows);
    expect(bars.map((b) => b.timeMs)).toEqual([100_000, 200_000]);
    expect(bars[0]?.close).toBe(1);
    expect(bars[1]?.volume).toBe(10);
  });

  it("parses full GeckoTerminal JSON envelope", () => {
    const json = {
      data: {
        attributes: {
          ohlcv_list: [[1_000, 1, 2, 0.5, 1.5, 3]],
        },
      },
      meta: {
        base: { symbol: "AAA" },
        quote: { symbol: "BBB" },
      },
    };
    const { bars, meta } = parseGeckoTerminalOhlcvJson(json);
    expect(bars).toHaveLength(1);
    expect(meta.baseSymbol).toBe("AAA");
    expect(meta.quoteSymbol).toBe("BBB");
  });
});
