import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensureDatabase, resetBootstrapForTests } from "@/db/bootstrap";
import { resetDatabaseForTests } from "@/db/client";
import { eventBus } from "@/server/event-bus";
import { startAgentRun } from "@/server/agent-runner";
import { createConversation } from "@/server/conversation-service";
import { createMessage, createRun, getRun, listMessages } from "@/server/repositories";
import { clearDelegationsForTests, issueDelegation } from "@/server/delegation";
import type { TaskExecutionIdentity } from "@/shared/evidence-types";

/**
 * A child run is delegated work, and #24 requires delegation to be a separate,
 * verifiable operation. These tests drive the enforcement where it lives — in
 * the run starter — rather than trusting that every caller remembers to pass a
 * grant.
 */

let tempDir: string;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentmeld-run-delegation-"));
  process.env.AGENTMELD_DATA_DIR = tempDir;
  resetBootstrapForTests();
  resetDatabaseForTests();
  eventBus.clearForTests();
  ensureDatabase();
  clearDelegationsForTests();
});

afterEach(() => {
  clearDelegationsForTests();
  resetBootstrapForTests();
  resetDatabaseForTests();
  delete process.env.AGENTMELD_DATA_DIR;
  eventBus.clearForTests();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function world() {
  const conversation = createConversation({ mode: "single", agentIds: ["ag_mock_builder"] });
  const now = Date.now();
  createRun({
    id: "run_parent",
    conversationId: conversation.id,
    agentId: "ag_mock_conductor",
    triggerMessageId: null,
    parentRunId: null,
    status: "running",
    now
  });
  const trigger = createMessage({
    id: "msg_delegation_trigger",
    conversationId: conversation.id,
    origin: "internal",
    role: "user",
    agentId: null,
    runId: null,
    parts: [{ type: "text", content: "delegated task prompt" }],
    status: "complete",
    mentionedAgentIds: ["ag_mock_builder"],
    parentMessageId: null,
    now
  });
  return { conversation, trigger };
}

function taskExecution(overrides: Partial<TaskExecutionIdentity> = {}): TaskExecutionIdentity {
  return {
    conductorRunId: "run_parent",
    planId: "plan_1",
    planRevision: 1,
    taskId: "task_1",
    attemptId: "att_1",
    attempt: 1,
    contextSnapshotId: "snap_1",
    ...overrides
  };
}

function grantFor(task: TaskExecutionIdentity, targetAgentId = "ag_mock_builder") {
  const issued = issueDelegation({
    sourceRunId: "run_parent",
    sourceAgentId: "ag_mock_conductor",
    targetAgentId,
    taskId: task.taskId,
    attempt: task.attempt
  });
  if (!issued.ok) throw new Error(issued.error);
  return issued.correlationId;
}

/** Did the runner post the "refused" notice rather than starting work? */
function refusalNotice(conversationId: string): string | undefined {
  return listMessages(conversationId)
    .map((message) => message.parts.map((part) => (part.type === "text" ? part.content : "")).join(""))
    .find((content) => content.includes("Delegation refused") || content.includes("without a delegation grant") || content.includes("must name the task") || content.includes("different conductor run"));
}

describe("delegated child runs", () => {
  it("refuses a child run that presents no grant", async () => {
    const { conversation, trigger } = world();
    const { runId, promise } = startAgentRun({
      conversationId: conversation.id,
      agentId: "ag_mock_builder",
      triggerMessage: trigger,
      runId: "run_child_nogrant",
      parentRunId: "run_parent",
      taskExecution: taskExecution()
    });
    await promise;

    expect(getRun(runId)).toBeNull();
    expect(refusalNotice(conversation.id)).toBeDefined();
  });

  it("refuses a child run whose grant names a different task", async () => {
    const { conversation, trigger } = world();
    // A grant minted for task_2, spent trying to start task_1.
    const correlationId = grantFor(taskExecution({ taskId: "task_2" }));

    const { runId, promise } = startAgentRun({
      conversationId: conversation.id,
      agentId: "ag_mock_builder",
      triggerMessage: trigger,
      runId: "run_child_wrongtask",
      parentRunId: "run_parent",
      delegationCorrelationId: correlationId,
      taskExecution: taskExecution({ taskId: "task_1" })
    });
    await promise;

    expect(getRun(runId)).toBeNull();
    expect(refusalNotice(conversation.id)).toContain("different run, agent, task or attempt");
  });

  it("refuses a child run whose grant belongs to another source run", async () => {
    const { conversation, trigger } = world();
    const execution = taskExecution();
    const correlationId = grantFor(execution);

    const { runId, promise } = startAgentRun({
      conversationId: conversation.id,
      agentId: "ag_mock_builder",
      triggerMessage: trigger,
      runId: "run_child_othersource",
      parentRunId: "run_other_parent",
      delegationCorrelationId: correlationId,
      taskExecution: execution
    });
    await promise;

    expect(getRun(runId)).toBeNull();
  });

  it("refuses a falsy grant just as firmly as a missing one", async () => {
    // The gate tests truthiness, not `=== undefined`: null and "" are refused
    // too, and each refusal is recorded rather than silently starting work.
    const { conversation, trigger } = world();
    for (const [index, correlationId] of [null, "", undefined].entries()) {
      const runId = `run_child_falsy_${index}`;
      const { promise } = startAgentRun({
        conversationId: conversation.id,
        agentId: "ag_mock_builder",
        triggerMessage: trigger,
        runId,
        parentRunId: "run_parent",
        delegationCorrelationId: correlationId,
        taskExecution: taskExecution()
      });
      await promise;
      expect(getRun(runId)).toBeNull();
    }
  });

  it("refuses a task identity that belongs to a different conductor run", async () => {
    // A valid grant for this parent, but the taskExecution claims another
    // conductor run: starting it would file evidence against that run's plan.
    const { conversation, trigger } = world();
    const execution = taskExecution();
    const correlationId = grantFor(execution);

    const { runId, promise } = startAgentRun({
      conversationId: conversation.id,
      agentId: "ag_mock_builder",
      triggerMessage: trigger,
      runId: "run_child_otherconductor",
      parentRunId: "run_parent",
      delegationCorrelationId: correlationId,
      taskExecution: { ...execution, conductorRunId: "run_someone_else" }
    });
    await promise;

    expect(getRun(runId)).toBeNull();
    expect(refusalNotice(conversation.id)).toContain("different conductor run");
  });

  it("refuses delegated work that does not name the task and attempt", async () => {
    const { conversation, trigger } = world();
    const { runId, promise } = startAgentRun({
      conversationId: conversation.id,
      agentId: "ag_mock_builder",
      triggerMessage: trigger,
      runId: "run_child_notask",
      parentRunId: "run_parent",
      delegationCorrelationId: "whatever"
    });
    await promise;

    expect(getRun(runId)).toBeNull();
    expect(refusalNotice(conversation.id)).toContain("must name the task and attempt");
  });

  it("spends the grant, so a replay cannot start the same work twice", async () => {
    const { conversation, trigger } = world();
    const execution = taskExecution();
    const correlationId = grantFor(execution);

    const first = startAgentRun({
      conversationId: conversation.id,
      agentId: "ag_mock_builder",
      triggerMessage: trigger,
      runId: "run_child_first",
      parentRunId: "run_parent",
      delegationCorrelationId: correlationId,
      taskExecution: execution
    });
    await first.promise;
    expect(getRun("run_child_first")).not.toBeNull();

    const replay = startAgentRun({
      conversationId: conversation.id,
      agentId: "ag_mock_builder",
      triggerMessage: trigger,
      runId: "run_child_replay",
      parentRunId: "run_parent",
      delegationCorrelationId: correlationId,
      taskExecution: execution
    });
    await replay.promise;

    expect(getRun("run_child_replay")).toBeNull();
    expect(refusalNotice(conversation.id)).toContain("already used");
  });

  it("lets a top-level run start without any grant", async () => {
    // The gate is about delegation, not about runs in general: a human-started
    // run has no parent and needs no grant.
    const { conversation, trigger } = world();
    const { runId, promise } = startAgentRun({
      conversationId: conversation.id,
      agentId: "ag_mock_builder",
      triggerMessage: trigger,
      runId: "run_top_level"
    });
    await promise;

    expect(getRun(runId)).not.toBeNull();
  });
});
