import { describe, expect, it, vi } from "vitest";

import { EventBus } from "@/server/event-bus";
import type { AgentRun } from "@/shared/types";

import { RunWaiter } from "./run-waiter";

describe("RunWaiter", () => {
  it("resolves from a run.end event", async () => {
    const bus = new EventBus();
    let run = createRun("running");
    const waiter = new RunWaiter({
      bus,
      getRun: () => run,
      abortRun: () => false,
    });
    const pending = waiter.waitForEnd(run.id, { timeoutMs: 500, pollIntervalMs: 10 });
    run = { ...run, status: "complete", finishedAt: Date.now() };
    bus.publish({
      type: "run.end",
      conversationId: run.conversationId,
      timestamp: Date.now(),
      runId: run.id,
      status: "complete",
    });

    await expect(pending).resolves.toMatchObject({ status: "complete", timedOut: false });
  });

  it("falls back to database polling when the event is missed", async () => {
    const bus = new EventBus();
    let run = createRun("running");
    const waiter = new RunWaiter({
      bus,
      getRun: () => run,
      abortRun: () => false,
    });
    const pending = waiter.waitForEnd(run.id, { timeoutMs: 500, pollIntervalMs: 5 });
    setTimeout(() => { run = { ...run, status: "complete", finishedAt: Date.now() }; }, 15);

    await expect(pending).resolves.toMatchObject({ status: "complete", timedOut: false });
  });

  it("does not trust run.end before the persisted run reaches a terminal state", async () => {
    const bus = new EventBus();
    let run = createRun("running");
    const waiter = new RunWaiter({ bus, getRun: () => run, abortRun: () => false });
    let resolved = false;
    const pending = waiter.waitForEnd(run.id, { timeoutMs: 500, pollIntervalMs: 10 })
      .then((result) => { resolved = true; return result; });

    bus.publish({
      type: "run.end",
      conversationId: run.conversationId,
      timestamp: Date.now(),
      runId: run.id,
      status: "failed",
      error: "published before persistence",
    });
    await new Promise((resolve) => setTimeout(resolve, 15));
    expect(resolved).toBe(false);

    run = { ...run, status: "failed", error: "persisted failure", finishedAt: Date.now() };
    await expect(pending).resolves.toMatchObject({ status: "failed", error: "persisted failure" });
  });

  it("aborts and resolves when the deadline is exceeded", async () => {
    const bus = new EventBus();
    const run = createRun("running");
    const abort = vi.fn(() => true);
    const waiter = new RunWaiter({ bus, getRun: () => run, abortRun: abort });

    const result = await waiter.waitForEnd(run.id, { timeoutMs: 25, pollIntervalMs: 5, abortGraceMs: 10 });

    expect(result.timedOut).toBe(true);
    expect(result.abortRequested).toBe(true);
    expect(abort).toHaveBeenCalledWith(run.id);
  });
});

function createRun(status: AgentRun["status"]): AgentRun {
  const now = Date.now();
  return {
    id: "run_waiter",
    conversationId: "conv_waiter",
    agentId: "ag_mock_conductor",
    triggerMessageId: "msg_waiter",
    parentRunId: null,
    status,
    stage: null,
    error: null,
    usage: null,
    interrupted: false,
    errorCategory: null,
    retryable: false,
    startedAt: now,
    finishedAt: status === "running" ? null : now,
    createdAt: now,
    updatedAt: now,
  };
}
