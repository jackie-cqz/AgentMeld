import { describe, expect, it } from "vitest";
import { descendantReceipts } from "./windows-process-tree";

describe("Windows native process ownership", () => {
  it("selects only descendants even if the OS table is out of order", () => {
    const rows = [{ pid: 30, parent: 20, born: "child" }, { pid: 99, parent: 1, born: "unrelated" }, { pid: 20, parent: 10, born: "shell" }];
    expect(descendantReceipts(rows, 10).map(row => row.pid)).toEqual([20, 30]);
    expect(descendantReceipts(rows, 40)).toEqual([]);
  });
  it("refuses a descendant without a creation-time identity", () => {
    expect(() => descendantReceipts([{ pid: 20, parent: 10, born: "" }], 10)).toThrow("owner");
  });
});
