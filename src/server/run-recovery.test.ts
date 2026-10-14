import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensureDatabase, resetBootstrapForTests } from "@/db/bootstrap";
import { getDatabase, resetDatabaseForTests as resetClientForTests } from "@/db/client";
import { recoverOrphanedRuns } from "@/server/run-recovery";
import { createRun, getRun, createMessage } from "@/server/repositories";
import { retireNonTerminalAttempts } from "@/server/repositories/evidence-repository";
import { createConversation } from "@/server/conversation-service";
import { eventBus } from "@/server/event-bus";

let tempDir: string;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-conf-recov-"));
  process.env.AGENTMELD_DATA_DIR = tempDir;
  resetBootstrapForTests();
  resetClientForTests();
  eventBus.clearForTests();
  ensureDatabase();
});

afterEach(() => {
  resetBootstrapForTests();
  resetClientForTests();
  delete process.env.AGENTMELD_DATA_DIR;
  eventBus.clearForTests();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("run-recovery", () => {
  // Shared fixture: need a real conversation + agent for FK constraints
  let convId: string;
  const agentId = "ag_mock_conductor";

  beforeEach(() => {
    const conv = createConversation({ mode: "single", agentIds: [agentId] });
    convId = conv.id;
  });

  it("marks orphaned running runs as interrupted", () => {
    const now = Date.now();
    const runId = "run_orphan_1";

    createRun({
      id: runId,
      conversationId: convId,
      agentId,
      triggerMessageId: null,
      parentRunId: null,
      status: "running",
      now
    });

    const before = getRun(runId);
    expect(before?.status).toBe("running");

    recoverOrphanedRuns();

    const after = getRun(runId);
    expect(after?.status).toBe("failed");
    expect(after?.error).toContain("interrupted");
    expect(after?.interrupted).toBe(true);
  });

  it("does not touch completed runs", () => {
    const now = Date.now();
    createRun({
      id: "run_complete_1",
      conversationId: convId,
      agentId,
      triggerMessageId: null,
      parentRunId: null,
      status: "complete",
      now: now - 1000
    });

    recoverOrphanedRuns();

    const run = getRun("run_complete_1");
    expect(run?.status).toBe("complete");
    expect(run?.interrupted).toBe(false);
  });

  it("handles no orphaned runs gracefully", () => {
    recoverOrphanedRuns();
  });

  // ── attempt rows left non-terminal by a run that already stopped ──────────────
  //
  // These are the rows an older build leaked. Their conductor run finished normally,
  // so an orphaned-run scan never sees them: the repair has to be driven by "the parent
  // run is no longer running", and it must not be skipped when there are no orphaned
  // runs at all (the early return that used to guard this function did exactly that).

  function insertAttempt(input: {
    id: string;
    conductorRunId: string;
    taskId?: string;
    executionStatus: string;
    verificationStatus?: string;
    finishedAt?: number | null;
  }) {
    const now = Date.now();
    getDatabase()
      .prepare(
        `INSERT INTO task_attempts (
           id, conductor_run_id, conversation_id, plan_id, plan_revision, task_id, agent_id,
           attempt, execution_status, verification_status, finished_at, created_at, updated_at
         ) VALUES (?, ?, ?, 'plan_x', 0, ?, ?, 1, ?, ?, ?, ?, ?)`
      )
      .run(
        input.id,
        input.conductorRunId,
        convId,
        input.taskId ?? "t1",
        agentId,
        input.executionStatus,
        input.verificationStatus ?? "not_started",
        input.finishedAt ?? null,
        now,
        now
      );
  }

  function attemptState(id: string) {
    return getDatabase()
      .prepare(
        "SELECT execution_status, verification_status, failure_context_json, finished_at FROM task_attempts WHERE id = ?"
      )
      .get(id) as
      | {
          execution_status: string;
          verification_status: string;
          failure_context_json: string | null;
          finished_at: number | null;
        }
      | undefined;
  }

  function createFinishedRun(id: string) {
    createRun({
      id,
      conversationId: convId,
      agentId,
      triggerMessageId: null,
      parentRunId: null,
      status: "complete",
      now: Date.now() - 1000
    });
  }

  it("retires an attempt left non-terminal by a run that already finished", () => {
    // Deliberately no orphaned runs: the repair must not depend on that scan.
    createFinishedRun("run_done_1");
    insertAttempt({ id: "ta_stale_1", conductorRunId: "run_done_1", executionStatus: "running" });

    recoverOrphanedRuns();

    const row = attemptState("ta_stale_1");
    expect(row?.execution_status).toBe("failed");
    expect(row?.verification_status).toBe("rejected");
    expect(row?.failure_context_json).toContain("non-terminal");
    expect(row?.finished_at).not.toBeNull();
  });

  it("retires a conductor meta-attempt as complete rather than failed", () => {
    // The meta-attempt is a pure evidence container, not a failed worker task: every
    // reader already filters `task_id = 'conductor'` out of task statistics.
    createFinishedRun("run_done_2");
    insertAttempt({
      id: "ta_meta_1",
      conductorRunId: "run_done_2",
      taskId: "conductor",
      executionStatus: "running"
    });

    recoverOrphanedRuns();

    const row = attemptState("ta_meta_1");
    expect(row?.execution_status).toBe("reported_complete");
    expect(row?.verification_status).toBe("not_started");
    expect(row?.finished_at).not.toBeNull();
  });

  it("leaves a terminal attempt untouched, including its finished_at", () => {
    createFinishedRun("run_done_3");
    insertAttempt({
      id: "ta_done_1",
      conductorRunId: "run_done_3",
      executionStatus: "reported_complete",
      verificationStatus: "verified",
      finishedAt: 12345
    });

    recoverOrphanedRuns();

    const row = attemptState("ta_done_1");
    expect(row?.execution_status).toBe("reported_complete");
    expect(row?.verification_status).toBe("verified");
    expect(row?.finished_at).toBe(12345);
  });

  it("does not touch an attempt whose run is still running", () => {
    // Asserted against the repository directly: recoverOrphanedRuns interrupts every
    // running run first, which would make this state unreachable through it.
    createRun({
      id: "run_live_1",
      conversationId: convId,
      agentId,
      triggerMessageId: null,
      parentRunId: null,
      status: "running",
      now: Date.now()
    });
    insertAttempt({ id: "ta_live_1", conductorRunId: "run_live_1", executionStatus: "running" });

    expect(retireNonTerminalAttempts(Date.now())).toBe(0);
    expect(attemptState("ta_live_1")?.execution_status).toBe("running");
  });
});
