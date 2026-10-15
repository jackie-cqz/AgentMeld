import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { getDatabase } from "@/db/client";
import { clearRunRefusalsForTests, recordRunRefusal } from "@/server/run-refusals";
import { executeConductorPlan } from "@/server/conductor-service";
import { clearAllTaskResultsForTests, recordTaskReport } from "@/server/dispatch-task-results";
import {
  answerQuestion,
  clearPendingQuestionsForTests,
  getAllPendingQuestions,
  registerPendingQuestion
} from "@/server/pending-questions";
import { createConversation, createMessage, createRun } from "@/server/repositories";
import type { ParsedTask } from "@/server/tools/conductor-tools";
import { setupTestDatabase } from "@/test/test-database";
import type { Message } from "@/shared/types";

// Stubbed: the child agent's entire run (`startAgentRun` — the run record, the
// adapter/model loop, tool execution and evidence collection) and context compilation.
// Real: the evaluator, the verification engine, the evidence ledger, the
// output-binding gate and the attempt bookkeeping, against an isolated database.
//
// Two consequences bound what this suite can catch, so they are stated rather than
// left implied: the real compiler and the `previousAttemptId`/`previousError` retry
// wiring never run here, and the minimal envelope hardcodes `blocked: false`, which
// makes the context-overflow branch unreachable from this file. Those paths have
// their own coverage.
const { startAgentRunMock } = vi.hoisted(() => ({ startAgentRunMock: vi.fn() }));

vi.mock("@/server/agent-runner", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/agent-runner")>();
  return {
    ...actual,
    startAgentRun: (...args: unknown[]) => startAgentRunMock(...args)
  };
});

type CompileTaskContextInput = Parameters<
  typeof import("@/server/task-context/context-compiler").compileTaskContext
>[0];

// Context compilation has its own suite and its own fixtures. Swapping in the
// minimal envelope keeps this file about attempt bookkeeping. The import is lazy
// because conductor-service imports this module: a static one would be circular.
vi.mock("@/server/task-context/context-compiler", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/task-context/context-compiler")>();
  return {
    ...actual,
    compileTaskContext: async (input: CompileTaskContextInput) => {
      const { buildMinimalContextEnvelope } = await import("@/server/conductor-service");
      return buildMinimalContextEnvelope(
        {
          conductorRunId: input.conductorRunId,
          planId: input.planId,
          planRevision: input.planRevision,
          taskId: input.task.id,
          attemptId: input.attemptId,
          attempt: input.attempt,
          contextSnapshotId: input.contextSnapshotId
        },
        input.task,
        input.resolvedInputs,
        input.upstreamArtifacts,
        input.attempt > 1 && input.previousAttemptId
          ? { previousAttemptId: input.previousAttemptId, error: input.previousError ?? "" }
          : undefined
      );
    }
  };
});

const WORKER = "ag_mock_builder";
const CONDUCTOR = "ag_mock_conductor";

let cleanupDatabase: (() => void) | undefined;

beforeAll(() => {
  cleanupDatabase = setupTestDatabase("agentmeld-attempt-status-");
});

afterAll(() => {
  cleanupDatabase?.();
});

afterEach(() => {
  startAgentRunMock.mockReset();
  clearPendingQuestionsForTests();
  clearAllTaskResultsForTests();
  // A refusal recorded by one case must not be read by the next.
  clearRunRefusalsForTests();
});

let seq = 0;

function seedConversationAndRun() {
  seq += 1;
  const suffix = `${seq}_${Date.now()}`;
  const conversationId = `conv_attempt_${suffix}`;
  const conductorRunId = `run_conductor_${suffix}`;
  const messageId = `msg_trigger_${suffix}`;
  const now = Date.now();

  createConversation({
    id: conversationId,
    title: "attempt status",
    mode: "group",
    agentIds: [WORKER, CONDUCTOR],
    fsWriteApprovalMode: "auto",
    now
  });
  // task_attempts.conductor_run_id references agent_runs, so the run must exist.
  createRun({
    id: conductorRunId,
    conversationId,
    agentId: CONDUCTOR,
    triggerMessageId: null,
    parentRunId: null,
    status: "running",
    now
  });
  const parts = [{ type: "text" as const, content: "做一个静态页面" }];
  createMessage({
    id: messageId,
    conversationId,
    role: "user",
    agentId: null,
    runId: null,
    parts,
    status: "complete",
    mentionedAgentIds: [],
    parentMessageId: null,
    now
  });

  const triggerMessage: Message = {
    id: messageId,
    conversationId,
    role: "user", origin: "human",
    agentId: null,
    runId: null,
    parts,
    status: "complete",
    mentionedAgentIds: [],
    parentMessageId: null,
    createdAt: now,
    updatedAt: now
  };

  return { conversationId, conductorRunId, messageId, triggerMessage };
}

function taskWith(overrides: Partial<ParsedTask> = {}): ParsedTask {
  return {
    id: "t1",
    agentId: WORKER,
    title: "建页面",
    prompt: "建一个静态页面",
    dependsOn: [],
    inputs: [],
    expectedOutputs: [],
    acceptanceCriteria: [],
    maxAttempts: 1,
    ...overrides
  };
}

/** The child never calls report_task_result, so every attempt fails evaluation. */
function childRunsThatNeverReport() {
  let child = 0;
  startAgentRunMock.mockImplementation(() => {
    child += 1;
    return { runId: `run_child_${child}`, promise: Promise.resolve() };
  });
}

/**
 * A runner that refused the delegation: it reports the reason the way the real
 * gate does, and hands back a run id that never became a run.
 */
function childRunsRefusedByTheGate(reason: string) {
  let child = 0;
  startAgentRunMock.mockImplementation((input: { runId?: string }) => {
    child += 1;
    const runId = input.runId ?? `run_child_${child}`;
    recordRunRefusal(runId, reason);
    return { runId, promise: Promise.resolve() };
  });
}

interface AttemptRow {
  task_id: string;
  attempt: number;
  execution_status: string;
  verification_status: string;
  failure_context_json: string | null;
}

function attemptRows(conversationId: string): AttemptRow[] {
  return getDatabase()
    .prepare(
      `SELECT task_id, attempt, execution_status, verification_status, failure_context_json
         FROM task_attempts WHERE conversation_id = ? ORDER BY attempt`
    )
    .all(conversationId) as AttemptRow[];
}

describe("conductor attempt bookkeeping", () => {
  // Regression: the retry loop wrote `execution_status` at the end of EVERY attempt
  // but left `verification_status` at the 'not_started' that a queued attempt starts
  // with. Only the final attempt was corrected, by the post-loop update. So a retried
  // attempt read as "verification never ran" even though it ran and rejected, which
  // hid the real reason — including "没有调用 report_task_result".
  it("writes a terminal verification status on every attempt, not only the last", async () => {
    const { conversationId, conductorRunId, messageId, triggerMessage } = seedConversationAndRun();
    childRunsThatNeverReport();

    await executeConductorPlan(
      conversationId,
      [taskWith({ maxAttempts: 2 })],
      [WORKER],
      conductorRunId,
      `plan_${conductorRunId}_init`,
      triggerMessage,
      CONDUCTOR,
      messageId
    );

    expect(startAgentRunMock).toHaveBeenCalledTimes(2);

    const rows = attemptRows(conversationId).filter((row) => row.task_id === "t1");
    expect(rows.map((row) => row.attempt)).toEqual([1, 2]);
    for (const row of rows) {
      expect(row.execution_status).toBe("failed");
      // Before the fix, attempt #1 was left at 'not_started' by this assertion.
      expect(row.verification_status).toBe("rejected");
      expect(row.failure_context_json).toContain("没有调用 report_task_result");
    }
  });

  it("reports a delegation refusal instead of blaming the agent", async () => {
    // The runner's gate refuses before any run row exists. The old handling
    // fell through to "the agent never called report_task_result", which sent
    // the reader looking at the agent instead of the delegation.
    const { conversationId, conductorRunId, messageId, triggerMessage } = seedConversationAndRun();
    childRunsRefusedByTheGate("Delegation refused: This delegation expired.");

    await executeConductorPlan(
      conversationId,
      [taskWith({ maxAttempts: 2 })],
      [WORKER],
      conductorRunId,
      `plan_${conductorRunId}_init`,
      triggerMessage,
      CONDUCTOR,
      messageId
    );

    const rows = attemptRows(conversationId).filter((row) => row.task_id === "t1");
    expect(rows).toHaveLength(1);
    expect(rows[0].execution_status).toBe("blocked");
    expect(rows[0].verification_status).toBe("rejected");
    expect(rows[0].failure_context_json).toContain("delegation_refused");
    expect(rows[0].failure_context_json).not.toContain("没有调用 report_task_result");
  });

  // The post-loop update already covered the single-attempt case, so this pins the
  // behaviour the retry case above must not drift away from.
  it("keeps a single-attempt failure terminal", async () => {
    const { conversationId, conductorRunId, messageId, triggerMessage } = seedConversationAndRun();
    childRunsThatNeverReport();

    await executeConductorPlan(
      conversationId,
      [taskWith({ maxAttempts: 1 })],
      [WORKER],
      conductorRunId,
      `plan_${conductorRunId}_init`,
      triggerMessage,
      CONDUCTOR,
      messageId
    );

    expect(startAgentRunMock).toHaveBeenCalledTimes(1);
    const rows = attemptRows(conversationId).filter((row) => row.task_id === "t1");
    expect(rows).toHaveLength(1);
    expect(rows[0].execution_status).toBe("failed");
    expect(rows[0].verification_status).toBe("rejected");
  });

  it("does not leave a queued attempt behind when the plan never dispatches", async () => {
    // An unknown agent makes validatePlan reject the plan before any attempt row
    // is created — the guard that keeps a rejected plan from leaking 'queued' rows.
    const { conversationId, conductorRunId, messageId, triggerMessage } = seedConversationAndRun();
    childRunsThatNeverReport();

    await executeConductorPlan(
      conversationId,
      [taskWith({ agentId: "ag_does_not_exist" })],
      [WORKER],
      conductorRunId,
      `plan_${conductorRunId}_init`,
      triggerMessage,
      CONDUCTOR,
      messageId
    );

    expect(startAgentRunMock).not.toHaveBeenCalled();
    expect(attemptRows(conversationId)).toHaveLength(0);
  });

  // A task can be evaluated "complete" and still be rejected afterwards, by the
  // missing-required-outputs gate that runs AFTER the retry loop. This is the case
  // that makes the post-loop update load-bearing rather than merely redundant, and
  // the reason the retry-case assertions above cannot stand in for it: with the
  // gate broken, everything else in this file still passes.
  it("records the post-loop rejection when a declared output was never produced", async () => {
    const { conversationId, conductorRunId, messageId, triggerMessage } = seedConversationAndRun();

    startAgentRunMock.mockImplementation(() => {
      const runId = "run_child_reported_complete";
      // report_task_result is called and claims completion, but no artifact and no
      // artifact_created evidence exists, so the declared output can never be bound.
      recordTaskReport(runId, {
        taskId: "t1",
        runId,
        status: "complete",
        summary: "done",
        acceptanceResults: [],
        blockers: [],
        artifacts: {}
      });
      return { runId, promise: Promise.resolve() };
    });

    await executeConductorPlan(
      conversationId,
      [taskWith({ expectedOutputs: [{ id: "out1", type: "document", required: true }] })],
      [WORKER],
      conductorRunId,
      `plan_${conductorRunId}_init`,
      triggerMessage,
      CONDUCTOR,
      messageId
    );

    const rows = attemptRows(conversationId).filter((row) => row.task_id === "t1");
    expect(rows).toHaveLength(1);
    // execution_status records what the agent did; verification_status is the
    // platform's verdict, re-judged by the output gate after the loop.
    expect(rows[0].execution_status).toBe("reported_complete");
    expect(rows[0].verification_status).toBe("rejected");
    expect(rows[0].failure_context_json).toContain("Missing required outputs");
  });

  // Regression: the attempt row is created before the child run and only finished at the
  // end of the iteration. A throw in between used to leave the row at 'queued' forever,
  // and — because executeConductorPlan awaits runChildTask through Promise.all with no
  // catch of its own — it also took the whole plan down with it.
  it("finishes the in-flight attempt when the child run throws", async () => {
    const { conversationId, conductorRunId, messageId, triggerMessage } = seedConversationAndRun();
    startAgentRunMock.mockImplementation(() => {
      throw new Error("child run exploded");
    });

    await expect(
      executeConductorPlan(
        conversationId,
        [taskWith()],
        [WORKER],
        conductorRunId,
        `plan_${conductorRunId}_init`,
        triggerMessage,
        CONDUCTOR,
        messageId
      )
    ).rejects.toThrow("child run exploded");

    const rows = attemptRows(conversationId).filter((row) => row.task_id === "t1");
    expect(rows).toHaveLength(1);
    expect(rows[0].execution_status).toBe("failed");
    expect(rows[0].verification_status).toBe("rejected");
    expect(rows[0].failure_context_json).toContain("child run exploded");
  });
});

describe("conductor meta-attempt created by a clarifying question", () => {
  // Regression: this row exists only so the user_answered evidence has an attempt to
  // hang off. It used to be inserted as 'running' and updated only by the approval
  // path, so a plan whose Conductor asked a question first — and was then abandoned
  // rather than approved — leaked a permanently running attempt.
  it("records the meta-attempt as terminal once the question is answered", async () => {
    const { conversationId, conductorRunId } = seedConversationAndRun();

    const pending = registerPendingQuestion(conversationId, CONDUCTOR, conductorRunId, [
      {
        question: "用哪种配色?",
        header: "配色",
        options: [{ label: "浅色" }, { label: "深色" }]
      }
    ]);

    const question = getAllPendingQuestions().find((item) => item.runId === conductorRunId);
    expect(question).toBeDefined();

    expect(answerQuestion(question!.id, { "用哪种配色?": "浅色" })).toBe(true);
    await pending;

    const row = getDatabase()
      .prepare(
        "SELECT execution_status, verification_status, started_at, finished_at FROM task_attempts WHERE id = ?"
      )
      .get(`ta_conductor_plan_${conductorRunId}_init`) as
      | {
          execution_status: string;
          verification_status: string;
          started_at: number | null;
          finished_at: number | null;
        }
      | undefined;

    expect(row).toBeDefined();
    // 'reported_complete' is this column's success token (see finishTaskAttempt).
    expect(row?.execution_status).toBe("reported_complete");
    // No verdicts exist for a row that was never dispatched, so it stays 'not_started'.
    expect(row?.verification_status).toBe("not_started");
    expect(row?.finished_at).not.toBeNull();
  });

  it("reuses the same meta-attempt row when the question is asked twice", async () => {
    // Conductor can ask several rounds before planning. Each round must land on the
    // same row id rather than inserting a second one or tripping a primary-key error.
    const { conversationId, conductorRunId } = seedConversationAndRun();

    for (const label of ["第一轮", "第二轮"]) {
      const pending = registerPendingQuestion(conversationId, CONDUCTOR, conductorRunId, [
        { question: `${label}怎么选?`, header: label, options: [{ label: "A" }, { label: "B" }] }
      ]);
      const question = getAllPendingQuestions().find((item) => item.runId === conductorRunId);
      expect(answerQuestion(question!.id, { [`${label}怎么选?`]: "A" })).toBe(true);
      await pending;
    }

    const rows = getDatabase()
      .prepare("SELECT execution_status FROM task_attempts WHERE id = ?")
      .all(`ta_conductor_plan_${conductorRunId}_init`) as Array<{ execution_status: string }>;

    expect(rows).toHaveLength(1);
    expect(rows[0].execution_status).toBe("reported_complete");
  });
});
