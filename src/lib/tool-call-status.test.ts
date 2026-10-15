import { describe, expect, it } from "vitest";
import { summarizeToolCalls, toolCallState } from "./tool-call-status";

describe("tool display status", () => {
  it("uses the payload for browser, command and job failures", () => {
    for (const [toolName, value] of [["browser_check", { passed: false }], ["job_wait", { status: "timed_out", exitCode: null }], ["job_cancel", { status: "cancelled" }], ["bash", { exitCode: 1 }]] as const) {
      expect(toolCallState(toolName, { result: { ok: true, value } }, true)).toBe("failed");
    }
    expect(toolCallState("fs_read", { result: { ok: false } }, true)).toBe("failed");
  });
  it("never treats missing or running results as completed", () => {
    expect(toolCallState("fs_read", undefined, false)).toBe("running");
    expect(toolCallState("fs_read", undefined, true)).toBe("failed");
    expect(toolCallState("job_start", { result: { ok: true, value: { status: "running" } } }, true)).toBe("running");
  });
  it("keeps group status and counts consistent with its items", () => {
    expect(summarizeToolCalls([
      { toolName: "fs_read", result: { result: { ok: true } } },
      { toolName: "browser_check", result: { result: { value: { passed: false } } } },
      { toolName: "job_wait", result: { result: { value: { status: "running" } } } }
    ], true)).toEqual({ complete: 1, failed: 1, running: 1, status: "error", label: "成功 1 · 失败 1 · 运行中 1" });
  });
  it("uses the latest result of the same job instead of leaving its start permanently running", () => {
    expect(summarizeToolCalls([
      { toolName: "job_start", result: { result: { value: { jobId: "j1", status: "running", exitCode: null } } } },
      { toolName: "job_wait", result: { result: { value: { jobId: "j1", status: "completed", exitCode: 0 } } } }
    ], true)).toMatchObject({ complete: 2, running: 0, failed: 0 });
  });
});
