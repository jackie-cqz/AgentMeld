import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensureDatabase, resetBootstrapForTests } from "@/db/bootstrap";
import { getDatabase, resetDatabaseForTests } from "@/db/client";
import { eventBus } from "@/server/event-bus";
import { startAgentRun } from "@/server/agent-runner";
import { createConversation } from "@/server/conversation-service";
import { createMessage, getRun, listMessages } from "@/server/repositories";
import type { AdapterName } from "@/shared/types";
import type { TaskExecutionIdentity } from "@/shared/evidence-types";
import { registerHarness, unregisterHarness } from "./registry";
import type { HarnessCapabilities, HarnessDriver, HarnessInvocationInput, HarnessRunStream } from "./types";

/**
 * The degradation check is only real if the real run entry point enforces it.
 * These tests drive `startAgentRun` and assert the harness never receives the
 * invocation, so no unverifiable output can be produced.
 */
let tempDir: string;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentmeld-harness-degradation-"));
  process.env.AGENTMELD_DATA_DIR = tempDir;
  resetBootstrapForTests();
  resetDatabaseForTests();
  eventBus.clearForTests();
  ensureDatabase();
});

afterEach(() => {
  unregisterHarness("mock");
  resetBootstrapForTests();
  resetDatabaseForTests();
  delete process.env.AGENTMELD_DATA_DIR;
  eventBus.clearForTests();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function seedRun(adapterName: AdapterName) {
  const conversation = createConversation({ mode: "single", agentIds: ["ag_mock_builder"] });
  getDatabase().prepare("UPDATE agents SET adapter_name = ? WHERE id = 'ag_mock_builder'").run(adapterName);
  const trigger = createMessage({
    id: `msg_degradation_${conversation.id}`,
    conversationId: conversation.id,
    origin: "human",
    role: "user",
    agentId: null,
    runId: null,
    parts: [{ type: "text", content: "Implement the compact sidebar" }],
    status: "complete",
    now: Date.now(),
  });
  return { conversation, trigger };
}

function fakeDriver(calls: HarnessInvocationInput[], overrides: Partial<HarnessCapabilities> = {}): HarnessDriver {
  return {
    id: "mock",
    doctor: () => ({ available: true, version: "fixture" }),
    capabilities: () => ({
      nativeTools: true,
      businessTools: true,
      cancellation: { supported: true, mode: "signal" },
      evidence: true,
      contextPacket: "platform",
      followUp: false,
      streaming: true,
      ...overrides,
    }),
    run: async function* (input): HarnessRunStream {
      calls.push(input);
      yield { type: "output.start", blockIndex: 0, kind: "text", content: "Fake harness reply" };
    },
    abort: () => false,
  };
}

function failedAgentMessage(conversationId: string, runId: string) {
  return listMessages(conversationId).find((message) => message.role === "agent" && message.runId === runId);
}

describe("capability degradation at the real run entry point", () => {
  it("fails before dispatch when the harness cannot call platform business tools", async () => {
    const { conversation, trigger } = seedRun("mock");
    const calls: HarnessInvocationInput[] = [];
    registerHarness(fakeDriver(calls, { businessTools: false }));

    const handle = startAgentRun({ conversationId: conversation.id, agentId: "ag_mock_builder", triggerMessage: trigger });
    await handle.promise;

    expect(calls).toHaveLength(0);
    expect(getRun(handle.runId)).toMatchObject({ status: "failed", errorCategory: "harness_capability" });
    const failed = failedAgentMessage(conversation.id, handle.runId);
    expect(failed?.status).toBe("error");
    expect(failed?.parts).toContainEqual({
      type: "text",
      content: expect.stringContaining("does not support platform business tools"),
    });
  });

  it("fails before dispatch when delegated work cannot be mapped into evidence", async () => {
    const { conversation, trigger } = seedRun("mock");
    const calls: HarnessInvocationInput[] = [];
    registerHarness(fakeDriver(calls, { evidence: false }));
    const taskExecution: TaskExecutionIdentity = {
      conductorRunId: "run_fixture_conductor",
      planId: "plan_fixture",
      planRevision: 0,
      taskId: "t1",
      attemptId: "attempt_fixture",
      attempt: 1,
      contextSnapshotId: "ctx_fixture",
    };

    const handle = startAgentRun({
      conversationId: conversation.id,
      agentId: "ag_mock_builder",
      triggerMessage: trigger,
      taskExecution,
    });
    await handle.promise;

    expect(calls).toHaveLength(0);
    expect(getRun(handle.runId)).toMatchObject({ status: "failed", errorCategory: "harness_capability" });
    expect(failedAgentMessage(conversation.id, handle.runId)?.parts).toContainEqual({
      type: "text",
      content: expect.stringContaining("mapping tool outcomes into the evidence ledger"),
    });
  });

  it("still dispatches a harness that declares everything the run needs", async () => {
    const { conversation, trigger } = seedRun("mock");
    const calls: HarnessInvocationInput[] = [];
    registerHarness(fakeDriver(calls));

    const handle = startAgentRun({ conversationId: conversation.id, agentId: "ag_mock_builder", triggerMessage: trigger });
    await handle.promise;

    expect(calls).toHaveLength(1);
    expect(getRun(handle.runId)?.status).toBe("complete");
  });
});
