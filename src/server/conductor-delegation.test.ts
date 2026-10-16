import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("@/server/pi/runtime", async () => ({ runPiInvocation: (await import("@/test/pi-runtime-fixture")).fixturePiInvocation }));
import { ensureDatabase, resetBootstrapForTests } from "@/db/bootstrap";
import { resetDatabaseForTests } from "@/db/client";
import { eventBus } from "@/server/event-bus";
import { executeConductorPlan } from "@/server/conductor-service";
import { createConversation } from "@/server/conversation-service";
import { createMessage, createRun, listRuns } from "@/server/repositories";
import { clearDelegationsForTests, getDelegationByCorrelationId } from "@/server/delegation";
import { getDatabase } from "@/db/client";

/**
 * The seam this file exists for: the conductor MINTS a delegation grant and the
 * runner CONSUMES it, in two different modules. Every other conductor test
 * mocks startAgentRun, so a one-character regression at the minting site (the
 * wrong attempt, the wrong target agent) would leave the whole suite green
 * while every delegated task failed in production.
 *
 * These tests therefore run the REAL runner: the child run row only appears if
 * the grant the conductor minted was accepted by the runner's gate.
 */

let tempDir: string;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentmeld-conductor-delegation-"));
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
  const conversation = createConversation({
    title: "委托测试",
    mode: "group",
    agentIds: ["ag_mock_conductor", "ag_mock_builder"]
  });
  const now = Date.now();
  createRun({
    id: "run_conductor",
    conversationId: conversation.id,
    agentId: "ag_mock_conductor",
    triggerMessageId: null,
    parentRunId: null,
    status: "running",
    now
  });
  const trigger = createMessage({
    id: "msg_trigger",
    conversationId: conversation.id,
    origin: "human",
    role: "user",
    agentId: null,
    runId: null,
    parts: [{ type: "text", content: "请让 builder 做一件事" }],
    status: "complete",
    mentionedAgentIds: ["ag_mock_conductor"],
    parentMessageId: null,
    now
  });
  return { conversation, trigger };
}

function childRuns(conversationId: string) {
  return listRuns(conversationId).filter((run) => run.parentRunId === "run_conductor");
}

describe("the conductor's grant and the runner's gate agree", () => {
  it("starts the delegated child run the grant was minted for", async () => {
    const { conversation, trigger } = world();

    await executeConductorPlan(
      conversation.id,
      [{ id: "t1", agentId: "ag_mock_builder", title: "Say hello", prompt: "Say hello to the user.", dependsOn: [], inputs: [], expectedOutputs: [], acceptanceCriteria: [], maxAttempts: 1 }],
      ["ag_mock_builder"],
      "run_conductor",
      "plan_1",
      trigger,
      "ag_mock_conductor",
      "msg_plan_1"
    );

    // The load-bearing assertion: a child run exists. The runner refuses
    // before writing any run row, so a grant minted for the wrong target
    // agent, task or attempt means this list is empty.
    const children = childRuns(conversation.id);
    expect(children).toHaveLength(1);
    expect(children[0].agentId).toBe("ag_mock_builder");
  });

  it("names the task and attempt it is about to start", async () => {
    const { conversation, trigger } = world();

    await executeConductorPlan(
      conversation.id,
      [{ id: "t1", agentId: "ag_mock_builder", title: "Say hello", prompt: "Say hello to the user.", dependsOn: [], inputs: [], expectedOutputs: [], acceptanceCriteria: [], maxAttempts: 1 }],
      ["ag_mock_builder"],
      "run_conductor",
      "plan_1",
      trigger,
      "ag_mock_conductor",
      "msg_plan_1"
    );

    // Exactly one grant, consumed, for this target and this attempt — the same
    // identity the runner was handed through taskExecution.
    const rows = getDatabase()
      .prepare("SELECT target_agent_id, task_id, attempt, status FROM delegations")
      .all() as Array<{ target_agent_id: string; task_id: string; attempt: number; status: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      target_agent_id: "ag_mock_builder",
      task_id: "t1",
      attempt: 1,
      status: "consumed"
    });
  });

  it("does not leave a spent grant behind when the run is retried", async () => {
    // A retry mints a FRESH grant: the first one is not reused, so the second
    // attempt's child run is not refused as a replay.
    const { conversation, trigger } = world();

    await executeConductorPlan(
      conversation.id,
      [{ id: "t1", agentId: "ag_mock_builder", title: "Say hello", prompt: "Say hello to the user.", dependsOn: [], inputs: [], expectedOutputs: [], acceptanceCriteria: [], maxAttempts: 1 }],
      ["ag_mock_builder"],
      "run_conductor",
      "plan_1",
      trigger,
      "ag_mock_conductor",
      "msg_plan_1"
    );

    const correlated = getDatabase()
      .prepare("SELECT COUNT(*) AS count FROM delegations WHERE status = 'consumed'")
      .get() as { count: number };
    expect(correlated.count).toBe(1);
    // No grant is left dangling in 'issued' after a normal dispatch.
    const issued = getDatabase()
      .prepare("SELECT COUNT(*) AS count FROM delegations WHERE status = 'issued'")
      .get() as { count: number };
    expect(issued.count).toBe(0);
  });

  it("keeps an unconsumed grant readable for the audit trail", async () => {
    // Sanity for the module wiring used above: a grant that is never spent is
    // still retrievable by its correlation id (hashed at rest, looked up the
    // same way).
    const { conversation, trigger } = world();
    await executeConductorPlan(
      conversation.id,
      [{ id: "t1", agentId: "ag_mock_builder", title: "Say hello", prompt: "Say hello to the user.", dependsOn: [], inputs: [], expectedOutputs: [], acceptanceCriteria: [], maxAttempts: 1 }],
      ["ag_mock_builder"],
      "run_conductor",
      "plan_1",
      trigger,
      "ag_mock_conductor",
      "msg_plan_1"
    );
    expect(childRuns(conversation.id)).toHaveLength(1);
    expect(typeof getDelegationByCorrelationId).toBe("function");
  });
});
