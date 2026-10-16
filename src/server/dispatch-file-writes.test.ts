import { describe, expect, it } from "vitest";
import { collapseTaskAttemptWrites, detectWaveConflicts, getFileWriteOrder, getFileWrites, recordFileWrite, clearFileWrites, type RunFileWrites } from "./dispatch-file-writes";

function writes(taskId: string, runId: string, paths: Array<[string, string]>): RunFileWrites {
  return { taskId, runId, agentId: `agent_${runId}`, writes: new Map(paths) };
}
describe("handoff file-write provenance", () => {
  it("keeps the actual last writer when a full-tool peer finishes before its source resumes", () => {
    const file = "consultation-order.ts";
    recordFileWrite("source-order", file, "before consultation");
    recordFileWrite("peer-order", file, "peer change");
    recordFileWrite("source-order", file, "source resumed");
    const source = { ...writes("t1", "source-order", []), writes: getFileWrites("source-order"), writeOrder: getFileWriteOrder("source-order") };
    const peer = { ...writes("t1", "peer-order", []), writes: getFileWrites("peer-order"), writeOrder: getFileWriteOrder("peer-order") };
    expect(collapseTaskAttemptWrites([source, peer])).toMatchObject([{ runId: "source-order", writes: getFileWrites("source-order") }]);
    expect(detectWaveConflicts(collapseTaskAttemptWrites([source, peer, writes("t2", "other-task", [[file, "another task"]])]))).toMatchObject([
      { path: file, contributors: [{ runId: "source-order" }, { runId: "other-task" }] },
    ]);
    clearFileWrites("source-order"); clearFileWrites("peer-order");
    expect(getFileWriteOrder("peer-order").size).toBe(0);
  });
  it("retains a source attempt's files when the receiving attempt did not overwrite them", () => {
    const source = writes("t1", "source", [["a.ts", "old-a"], ["b.ts", "old-b"]]);
    const receiver = writes("t1", "receiver", [["b.ts", "new-b"]]);
    const collapsed = collapseTaskAttemptWrites([source, receiver]);
    expect(collapsed).toEqual([
      writes("t1", "source", [["a.ts", "old-a"]]), writes("t1", "receiver", [["b.ts", "new-b"]]),
    ]);
    expect(detectWaveConflicts(collapsed)).toEqual([]);
    expect(source.writes.get("b.ts")).toBe("old-b");
  });
  it("still detects another task overwriting a file changed before the handoff", () => {
    const collapsed = collapseTaskAttemptWrites([
      writes("t1", "source", [["a.ts", "source-a"]]), writes("t1", "receiver", [["b.ts", "receiver-b"]]),
      writes("t2", "other", [["a.ts", "other-a"]]),
    ]);
    expect(detectWaveConflicts(collapsed)).toEqual([{ path: "a.ts", contributors: [
      { taskId: "t1", runId: "source", agentId: "agent_source" }, { taskId: "t2", runId: "other", agentId: "agent_other" },
    ] }]);
  });
});
