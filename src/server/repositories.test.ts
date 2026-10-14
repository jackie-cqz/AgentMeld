// ---------------------------------------------------------------------------
// Repository-level persistence tests
//
// These cover columns that are easy to leave on their schema default because
// nothing reads them in the happy path — verification_status was one of them.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import { getDatabase } from "@/db/client";
import { createConversation, createRun, persistConductorTask } from "@/server/repositories";
import { setupTestDatabase } from "@/test/test-database";

function readVerificationStatus(id: string): string | undefined {
  const row = getDatabase()
    .prepare("SELECT verification_status FROM conductor_task_results WHERE id = ?")
    .get(id) as { verification_status: string } | undefined;
  return row?.verification_status;
}

function seedConversationAndRun(conversationId: string, runId: string, now: number): void {
  createConversation({
    id: conversationId,
    title: "repository test",
    mode: "single",
    agentIds: ["ag_pm"],
    fsWriteApprovalMode: "auto",
    now
  });
  createRun({
    id: runId,
    conversationId,
    agentId: "ag_pm",
    triggerMessageId: null,
    parentRunId: null,
    status: "running",
    now
  });
}

describe("persistConductorTask", () => {
  it("stores the evidence-verification outcome instead of the column default", () => {
    const teardown = setupTestDatabase("agentmeld-repo-task-");
    try {
      const now = Date.now();
      seedConversationAndRun("conv_task", "run_task", now);

      persistConductorTask({
        id: "res_verified", conductorRunId: "run_task", conversationId: "conv_task",
        taskId: "t1", agentId: "ag_pm", status: "complete", summary: "done",
        childRunId: "run_child", attempt: 1, verificationStatus: "verified", now
      });
      expect(readVerificationStatus("res_verified")).toBe("verified");

      persistConductorTask({
        id: "res_rejected", conductorRunId: "run_task", conversationId: "conv_task",
        taskId: "t2", agentId: "ag_pm", status: "failed", summary: "no evidence",
        childRunId: "run_child_2", attempt: 1, verificationStatus: "rejected", now
      });
      expect(readVerificationStatus("res_rejected")).toBe("rejected");
    } finally {
      teardown();
    }
  });

  it("reports not_started for a task that never produced an attempt", () => {
    const teardown = setupTestDatabase("agentmeld-repo-task-");
    try {
      const now = Date.now();
      seedConversationAndRun("conv_task", "run_task", now);

      persistConductorTask({
        id: "res_skipped", conductorRunId: "run_task", conversationId: "conv_task",
        taskId: "t3", agentId: "ag_pm", status: "skipped", summary: "upstream failed",
        childRunId: null, attempt: 1, now
      });
      expect(readVerificationStatus("res_skipped")).toBe("not_started");
    } finally {
      teardown();
    }
  });

  it("overwrites the outcome when a recovery task replaces the original row", () => {
    // promoteRecoveryResult re-persists under the ORIGINAL task id, so the
    // INSERT OR REPLACE has to carry the new outcome — otherwise a repaired task
    // would keep reporting the earlier 'rejected'.
    const teardown = setupTestDatabase("agentmeld-repo-task-");
    try {
      const now = Date.now();
      seedConversationAndRun("conv_task", "run_task", now);

      const base = {
        id: "res_t1", conductorRunId: "run_task", conversationId: "conv_task",
        taskId: "t1", agentId: "ag_pm", summary: "first attempt",
        childRunId: "run_child", attempt: 1, now
      };
      persistConductorTask({ ...base, status: "failed", verificationStatus: "rejected" });
      expect(readVerificationStatus("res_t1")).toBe("rejected");

      persistConductorTask({ ...base, status: "complete", attempt: 2, verificationStatus: "verified" });
      expect(readVerificationStatus("res_t1")).toBe("verified");
    } finally {
      teardown();
    }
  });
});
