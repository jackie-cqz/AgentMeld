// ---------------------------------------------------------------------------
// Repository-level persistence tests
//
// These cover columns that are easy to leave on their schema default because
// nothing reads them in the happy path — verification_status was one of them.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import { ensureDatabase, resetBootstrapForTests } from "@/db/bootstrap";
import { getDatabase } from "@/db/client";
import {
  createConversation,
  createMessage,
  createRun,
  getMessage,
  persistConductorTask
} from "@/server/repositories";
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

describe("message origin", () => {
  it("defaults by role and honours an explicit origin", () => {
    const teardown = setupTestDatabase("agentmeld-repo-origin-");
    try {
      const now = Date.now();
      seedConversationAndRun("conv_origin", "run_origin", now);

      const human = createMessage({
        id: "msg_human", conversationId: "conv_origin", role: "user",
        parts: [{ type: "text", content: "hi" }], status: "complete", now
      });
      expect(human.origin).toBe("human");

      // Agent output is produced by the runtime, not authored by a person.
      const agentMessage = createMessage({
        id: "msg_agent", conversationId: "conv_origin", role: "agent",
        parts: [{ type: "text", content: "out" }], status: "complete", now
      });
      expect(agentMessage.origin).toBe("bot");

      // Channel ingress states the origin itself; it must win over the default.
      const botMessage = createMessage({
        id: "msg_bot", conversationId: "conv_origin", role: "user", origin: "bot",
        parts: [{ type: "text", content: "echo" }], status: "complete", now
      });
      expect(botMessage.origin).toBe("bot");
    } finally {
      teardown();
    }
  });

  it("derives origin by role when the column is added to an existing database", () => {
    // The real risk in this migration is not "does the column appear" but
    // "what do the rows that predate it become". Labelling them all 'human'
    // would contradict defaultOriginForRole, which gives agent rows 'bot' and
    // system rows 'internal'. So this drops the column, writes legacy rows,
    // then runs the migration the way a real upgrade would.
    const teardown = setupTestDatabase("agentmeld-repo-origin-migrate-");
    try {
      const now = Date.now();
      seedConversationAndRun("conv_origin", "run_origin", now);
      const db = getDatabase();

      db.exec("ALTER TABLE messages DROP COLUMN origin");

      const insertLegacy = db.prepare(`
        INSERT INTO messages
          (id, conversation_id, role, agent_id, run_id, parts, status,
           mentioned_agent_ids, parent_message_id, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const parts = JSON.stringify([{ type: "text", content: "legacy" }]);
      insertLegacy.run("m_legacy_user", "conv_origin", "user", null, null, parts, "complete", "[]", null, now, now);
      insertLegacy.run("m_legacy_agent", "conv_origin", "agent", null, null, parts, "complete", "[]", null, now, now);
      insertLegacy.run("m_legacy_system", "conv_origin", "system", null, null, parts, "complete", "[]", null, now, now);

      resetBootstrapForTests();
      ensureDatabase();

      expect(getMessage("m_legacy_user")?.origin).toBe("human");
      expect(getMessage("m_legacy_agent")?.origin).toBe("bot");
      expect(getMessage("m_legacy_system")?.origin).toBe("internal");

      // The backfill must belong to the ALTER, not to every boot. A row created
      // afterwards with a deliberate origin for its role has to survive a later
      // bootstrap untouched.
      createMessage({
        id: "m_after_migration", conversationId: "conv_origin", role: "agent", origin: "human",
        parts: [{ type: "text", content: "deliberate" }], status: "complete", now
      });
      resetBootstrapForTests();
      ensureDatabase();
      expect(getMessage("m_after_migration")?.origin).toBe("human");
    } finally {
      teardown();
    }
  });

  it("accepts an out-of-enum origin, because the column has no CHECK constraint", () => {
    // Named for what it actually asserts. There is no runtime validation of the
    // value: TypeScript is the only guard, so a production caller using the same
    // cast could store garbage. Documented rather than hidden.
    const teardown = setupTestDatabase("agentmeld-repo-origin-");
    try {
      const now = Date.now();
      seedConversationAndRun("conv_origin", "run_origin", now);

      createMessage({
        id: "msg_bogus", conversationId: "conv_origin", role: "user",
        origin: "nonsense" as never,
        parts: [{ type: "text", content: "?" }], status: "complete", now
      });

      const row = getDatabase()
        .prepare("SELECT origin FROM messages WHERE id = ?")
        .get("msg_bogus") as { origin: string };
      expect(row.origin).toBe("nonsense");
    } finally {
      teardown();
    }
  });
});
