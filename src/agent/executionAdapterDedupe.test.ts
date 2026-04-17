import { describe, expect, it } from "vitest";
import { CapturingExecutionAdapter, createDedupingExecutionAdapter } from "./executionAdapter.js";

describe("createDedupingExecutionAdapter", () => {
  it("forwards each distinct (barIndex, timeMs) once per kind", async () => {
    const inner = new CapturingExecutionAdapter();
    const deduped = createDedupingExecutionAdapter(inner);
    const p = { barIndex: 4, timeMs: 5000, reason: "x" };
    await Promise.resolve(deduped.onSignalEntry(p));
    await Promise.resolve(deduped.onSignalEntry(p));
    await Promise.resolve(deduped.onSignalExit({ barIndex: 5, timeMs: 6000, reason: "y" }));
    await Promise.resolve(deduped.onSignalExit({ barIndex: 5, timeMs: 6000, reason: "y" }));
    expect(inner.entries).toHaveLength(1);
    expect(inner.exits).toHaveLength(1);
  });

  it("allows the same barIndex with different timeMs", async () => {
    const inner = new CapturingExecutionAdapter();
    const deduped = createDedupingExecutionAdapter(inner);
    await Promise.resolve(deduped.onSignalEntry({ barIndex: 1, timeMs: 100, reason: "a" }));
    await Promise.resolve(deduped.onSignalEntry({ barIndex: 1, timeMs: 200, reason: "b" }));
    expect(inner.entries).toHaveLength(2);
  });
});
