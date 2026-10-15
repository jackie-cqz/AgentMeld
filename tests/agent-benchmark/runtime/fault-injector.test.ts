import { afterEach, describe, expect, it, vi } from "vitest";

import { EventBus } from "@/server/event-bus";
import { toolRegistry } from "@/server/tools/registry";
import type { ToolContext } from "@/server/tools/types";
import { FaultInjector } from "./fault-injector";

let active: FaultInjector | null = null;

afterEach(() => {
  active?.stop();
  active = null;
});

describe("benchmark fault injector", () => {
  it("injects a configured fault at the requested occurrence and records task identity", async () => {
    active = new FaultInjector([{ id: "build-1", type: "command_nonzero", toolName: "bash", commandPattern: "build", occurrence: 1 }]);
    active.start();
    const result = await toolRegistry.execute("bash", { command: "pnpm build" }, context());
    expect(result.ok).toBe(false);
    expect(active.getRecords()).toEqual([expect.objectContaining({ id: "build-1", occurrence: 1, taskId: "r1" })]);
  });

  it("deterministically corrupts the selected tool argument document once", () => {
    active = new FaultInjector([{ id: "json-1", type: "tool_arguments_json", toolName: "write_artifact", occurrence: 1 }]);
    expect(() => active!.start()).toThrow("not supported by the Pi runtime");
    const malformed = active.injectToolArguments({
      runId: "run_child",
      toolName: "write_artifact",
      rawArguments: '{"type":"document"}',
    });
    expect(malformed).toBe('{"type":"document"');
    expect(active.injectToolArguments({ runId: "run_child", toolName: "write_artifact", rawArguments: "{}" })).toBeNull();
    expect(active.getRecords()).toEqual([expect.objectContaining({ id: "json-1", runId: "run_child" })]);
  });

  it("injects an unsupported deployment claim into parsed report_task_result args", async () => {
    active = new FaultInjector([{
      id: "fake-deploy",
      type: "task_report_fake_deployment",
      toolName: "report_task_result",
      occurrence: 1,
    }]);
    active.start();
    const args = { status: "complete", summary: "Workspace inspected.", acceptanceResults: [] };
    const result = await toolRegistry.execute("report_task_result", args, context());
    expect(result.ok).toBe(true);
    expect(args.summary).toContain("/deployments/dep_benchmark_fake");
    expect(active.getRecords()).toEqual([
      expect.objectContaining({ id: "fake-deploy", type: "task_report_fake_deployment" }),
    ]);
  });

  it("records a missing deployment path as a failed tool call", async () => {
    active = new FaultInjector([{
      id: "missing-deploy",
      type: "deployment_missing",
      toolName: "deploy_workspace",
      occurrence: 1,
    }]);
    active.start();

    const result = await toolRegistry.execute(
      "deploy_workspace",
      { path: "dist", title: "App", outputKey: "web_app" },
      context(),
    );

    expect(result).toEqual(expect.objectContaining({
      ok: false,
      code: "BENCHMARK_DEPLOYMENT_PATH_MISSING",
      category: "tool_error",
    }));
    expect(active.getRecords()).toEqual([
      expect.objectContaining({ id: "missing-deploy", taskId: "r1" }),
    ]);
  });

  it("cannot be attached outside an explicit benchmark environment", () => {
    delete process.env.AGENTMELD_BENCH_FAULT_INJECTION;
    expect(() => toolRegistry.setExecutionInterceptorForTests(() => ({ ok: false, error: "no" }))).toThrow("explicit benchmark");
  });

  it("records a deterministic temporary SSE disconnect", () => {
    active = new FaultInjector([{ id: "sse-1", type: "sse_disconnect", toolName: "event_bus", occurrence: 1 }]);
    active.start();
    expect(active.shouldDropRunEndEvent("run_parent", 1)).toBe(true);
    expect(active.shouldDropRunEndEvent("run_parent", 2)).toBe(false);
    expect(active.getRecords()).toEqual([
      expect.objectContaining({ id: "sse-1", type: "sse_disconnect", runId: "run_parent", occurrence: 1 }),
    ]);
  });

  it("aborts only the configured child run occurrence", () => {
    const bus = new EventBus();
    const abort = vi.fn(() => true);
    active = new FaultInjector(
      [{ id: "child-2", type: "child_run_abort", toolName: "child_run", occurrence: 2 }],
      { bus, abortRun: abort },
    );
    active.start();
    bus.publish({
      type: "run.start", conversationId: "conv_1", timestamp: 1, runId: "run_child_1",
      agentId: "ag_frontend", triggerMessageId: "msg_1", parentRunId: "run_parent",
    });
    bus.publish({
      type: "run.start", conversationId: "conv_1", timestamp: 2, runId: "run_child_2",
      agentId: "ag_reviewer", triggerMessageId: "msg_2", parentRunId: "run_parent",
    });
    expect(abort).toHaveBeenCalledTimes(1);
    expect(abort).toHaveBeenCalledWith("run_child_2");
    expect(active.getRecords()).toEqual([
      expect.objectContaining({ id: "child-2", type: "child_run_abort", runId: "run_child_2", occurrence: 2 }),
    ]);
  });
});

function context(): ToolContext {
  return {
    conversationId: "conv_1",
    workspacePath: process.cwd(),
    agentId: "ag_frontend",
    runId: "run_child",
    parentRunId: "run_parent",
    taskExecution: { conductorRunId: "run_parent", planId: "plan_1", planRevision: 0, taskId: "r1", attemptId: "att_1", attempt: 1, contextSnapshotId: "ctx_1" },
    abortSignal: new AbortController().signal,
  };
}
