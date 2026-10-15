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

  it("settles the messages an interrupted run was streaming into", async () => {
    // Only the run that owns a message ever finishes it, so a restart left the
    // row `streaming` forever: the room showed a message spinning with nothing
    // in it, which is indistinguishable from a frozen server. Recovery marks
    // the run; it has to settle the message too.
    const now = Date.now();
    const runId = "run_streaming_1";
    createRun({
      id: runId,
      conversationId: convId,
      agentId,
      triggerMessageId: null,
      parentRunId: null,
      status: "running",
      now
    });
    const message = createMessage({
      id: "msg_streaming_1",
      conversationId: convId,
      agentId,
      role: "agent",
      runId,
      parts: [{ type: "text", content: "写了一半" }],
      status: "streaming",
      now
    });

    recoverOrphanedRuns();

    const row = getDatabase()
      .prepare("SELECT status, parts FROM messages WHERE id = ?")
      .get(message.id) as { status: string; parts: string };
    // `error`, not `failed`: a MESSAGE status is one of
    // streaming | complete | error | aborted, and writing a RUN status here put
    // a value the client cannot render into the database — which is a white
    // screen, not a degraded row.
    expect(["streaming", "complete", "error", "aborted"]).toContain(row.status);
    expect(row.status).toBe("error");
    // The answer that did arrive is kept, and the row explains itself.
    expect(row.parts).toContain("写了一半");
    expect(row.parts).toContain("中断");
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
    attempt?: number;
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
         ) VALUES (?, ?, ?, 'plan_x', 0, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        input.id,
        input.conductorRunId,
        convId,
        input.taskId ?? "t1",
        agentId,
        input.attempt ?? 1,
        input.executionStatus,
        input.verificationStatus ?? "not_started",
        input.finishedAt ?? null,
        now,
        now
      );
  }

  /** The recorded reason, whichever wording the production message happens to use. */
  function failureReason(json: string | null | undefined): string | null {
    if (!json) return null;
    try {
      const parsed = JSON.parse(json) as { error?: unknown };
      return typeof parsed.error === "string" && parsed.error.length > 0 ? parsed.error : null;
    } catch {
      return null;
    }
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
    // Assert the SHAPE of the recorded reason, not a substring of the production
    // wording: matching the message makes any rewording a red test with no behaviour
    // change, and hides whether a reason was recorded at all.
    expect(failureReason(row?.failure_context_json)).toBeTruthy();
    expect(row?.finished_at).not.toBeNull();
  });

  it("retires a conductor meta-attempt as complete rather than failed", () => {
    // The meta-attempt is a pure evidence container, not a failed worker task: every
    // reader already filters `task_id = 'conductor'` out of task statistics. It is
    // identified by attempt 0 — a real attempt starts at 1.
    createFinishedRun("run_done_2");
    insertAttempt({
      id: "ta_meta_1",
      conductorRunId: "run_done_2",
      taskId: "conductor",
      attempt: 0,
      executionStatus: "running"
    });

    recoverOrphanedRuns();

    const row = attemptState("ta_meta_1");
    expect(row?.execution_status).toBe("reported_complete");
    expect(row?.verification_status).toBe("not_started");
    expect(row?.finished_at).not.toBeNull();
  });

  it("treats a plan task merely NAMED conductor as a normal failed attempt", () => {
    // Plan task ids come from the model and validatePlan does not reserve the word, so
    // the id alone cannot classify a row: repairing a real task to the success token
    // would hide a genuine failure.
    createFinishedRun("run_done_5");
    insertAttempt({
      id: "ta_named_conductor",
      conductorRunId: "run_done_5",
      taskId: "conductor",
      attempt: 1,
      executionStatus: "running"
    });

    recoverOrphanedRuns();

    const row = attemptState("ta_named_conductor");
    expect(row?.execution_status).toBe("failed");
    expect(row?.verification_status).toBe("rejected");
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

  it("keeps an existing finished_at when retiring a row", () => {
    // A non-terminal row that already carries finished_at is the only way to reach the
    // COALESCE; without it a repair pass would re-timestamp an already-finished row.
    createFinishedRun("run_done_4");
    insertAttempt({
      id: "ta_partial_1",
      conductorRunId: "run_done_4",
      executionStatus: "running",
      finishedAt: 12345
    });

    recoverOrphanedRuns();

    const row = attemptState("ta_partial_1");
    expect(row?.execution_status).toBe("failed");
    expect(row?.finished_at).toBe(12345);
  });

  // The contract at the only production call site. recoverOrphanedRuns force-fails EVERY
  // running run before the sweep, so a live run and its in-flight attempt are both marked
  // failed. That is correct at process start — nothing can be in flight — but it means the
  // sweep's `status <> 'running'` filter is NOT what protects a live attempt; the
  // precondition documented on recoverOrphanedRuns is. Pinning the real behaviour here
  // stops that filter from being mistaken for a safety net.
  it("force-fails a running run and its in-flight attempt through the entry point", () => {
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

    recoverOrphanedRuns();

    expect(getRun("run_live_1")?.status).toBe("failed");
    expect(getRun("run_live_1")?.interrupted).toBe(true);
    expect(attemptState("ta_live_1")?.execution_status).toBe("failed");
  });

  // Called directly, the sweep does skip a run that is still running. The entry point
  // never reaches this state, so this documents the function's isolated behaviour — and
  // the gap between it and the contract above is exactly why a second caller would need
  // to pass run ids explicitly instead of relying on the filter.
  it("skips an attempt whose run is still running, when called directly", () => {
    createRun({
      id: "run_live_2",
      conversationId: convId,
      agentId,
      triggerMessageId: null,
      parentRunId: null,
      status: "running",
      now: Date.now()
    });
    insertAttempt({ id: "ta_live_2", conductorRunId: "run_live_2", executionStatus: "running" });

    expect(retireNonTerminalAttempts(Date.now())).toBe(0);
    expect(attemptState("ta_live_2")?.execution_status).toBe("running");
  });
});
