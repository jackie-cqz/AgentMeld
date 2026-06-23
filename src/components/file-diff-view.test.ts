import { describe, expect, it } from "vitest";
import { buildLineDiff } from "@/components/file-diff-view";

describe("buildLineDiff", () => {
  it("marks inserted and removed lines while preserving common lines", () => {
    const result = buildLineDiff("alpha\nbeta\ngamma", "alpha\nbeta changed\ngamma\ndelta");

    expect(result).toEqual([
      { kind: "same", oldNumber: 1, newNumber: 1, content: "alpha" },
      { kind: "removed", oldNumber: 2, newNumber: null, content: "beta" },
      { kind: "added", oldNumber: null, newNumber: 2, content: "beta changed" },
      { kind: "same", oldNumber: 3, newNumber: 3, content: "gamma" },
      { kind: "added", oldNumber: null, newNumber: 4, content: "delta" }
    ]);
  });
});
