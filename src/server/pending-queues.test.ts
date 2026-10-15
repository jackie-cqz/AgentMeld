import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ensureDatabase, resetBootstrapForTests } from "@/db/bootstrap";
import { getDatabase } from "@/db/client";
import { eventBus } from "@/server/event-bus";
import { setupTestDatabase } from "@/test/test-database";
import {
  getApprovalRecord,
  interruptAllPendingApprovals,
  MAX_RESOLVED_BY_LENGTH,
  resolveApproval,
  SYSTEM_RESOLVED_BY
} from "@/server/repositories";
import {
  approvePendingWrite,
  cancelPendingWritesForRun,
  clearPendingWritesForTests,
  getAllPendingWrites,
  getPendingWrite,
  getPendingWritesForConversation,
  registerPendingWrite,
  rejectPendingWrite
} from "@/server/pending-writes";
import {
  approvePendingBash,
  cancelPendingBashForRun,
  clearPendingBashForTests,
  getAllPendingBashCommands,
  getPendingBashCommandsForConversation,
  registerPendingBash,
  rejectPendingBash
} from "@/server/pending-bash";

let cleanupDatabase: (() => void) | undefined;

beforeAll(() => {
  cleanupDatabase = setupTestDatabase("agentmeld-pending-queues-");
});

afterAll(() => {
  cleanupDatabase?.();
});

beforeEach(() => {
  eventBus.clearForTests();
  clearPendingWritesForTests();
  clearPendingBashForTests();
});

afterEach(() => {
  clearPendingWritesForTests();
  clearPendingBashForTests();
  eventBus.clearForTests();
});

describe("pending-writes", () => {
  it("registers a pending write and returns a promise", () => {
    const promise = registerPendingWrite("conv_write_1", "ag_1", "run_write_1", "test.txt", "/ws/test.txt", null, "new content");
    expect(promise).toBeInstanceOf(Promise);
  });

  it("publishes a pending event when a write requires approval", () => {
    registerPendingWrite(
      "conv_write_1",
      "ag_1",
      "run_write_1",
      "test.txt",
      "/ws/test.txt",
      null,
      "new content"
    );

    const [entry] = eventBus.replayAfter(0);
    expect(entry.event.type).toBe("fs_write.pending");
    if (entry.event.type === "fs_write.pending") {
      expect(entry.event.pendingWrite.path).toBe("test.txt");
      expect(entry.event.conversationId).toBe("conv_write_1");
    }
  });

  it("lists all registered writes", () => {
    registerPendingWrite("conv_write_1", "ag_1", "run_write_1", "a.txt", "/ws/a.txt", null, "x");
    registerPendingWrite("conv_write_2", "ag_2", "run_write_2", "b.txt", "/ws/b.txt", null, "y");

    const all = getAllPendingWrites();
    expect(all).toHaveLength(2);
  });

  it("filters writes by conversation", () => {
    registerPendingWrite("conv_write_1", "ag_1", "run_write_1", "a.txt", "/ws/a.txt", null, "x");
    registerPendingWrite("conv_write_2", "ag_2", "run_write_2", "b.txt", "/ws/b.txt", null, "y");

    const filtered = getPendingWritesForConversation("conv_write_1");
    expect(filtered).toHaveLength(1);
    expect(filtered[0].path).toBe("a.txt");
  });

  it("approval resolves the promise with true", async () => {
    const promise = registerPendingWrite("conv_write_1", "ag_1", "run_write_1", "test.txt", "/ws/test.txt", null, "content");

    // Resolve in next tick
    setTimeout(() => {
      const all = getAllPendingWrites();
      approvePendingWrite(all[0].id);
    }, 10);

    const result = await promise;
    expect(result).toBe(true);
    expect(getAllPendingWrites()).toHaveLength(0);
  });

  it("allows a pending write to be resolved only once", async () => {
    const promise = registerPendingWrite("conv_write_1", "ag_1", "run_write_1", "test.txt", "/ws/test.txt", null, "content");
    const id = getAllPendingWrites()[0].id;

    expect(approvePendingWrite(id)).toBe(true);
    expect(rejectPendingWrite(id)).toBe(false);
    await expect(promise).resolves.toBe(true);
  });

  it("rejection resolves the promise with false", async () => {
    const promise = registerPendingWrite("conv_write_1", "ag_1", "run_write_1", "test.txt", "/ws/test.txt", null, "content");

    setTimeout(() => {
      const all = getAllPendingWrites();
      rejectPendingWrite(all[0].id);
    }, 10);

    const result = await promise;
    expect(result).toBe(false);
  });

  it("getPendingWrite returns undefined for unknown id", () => {
    expect(getPendingWrite("nonexistent")).toBeUndefined();
  });

  it("cancelPendingWritesForRun removes all writes for a run", () => {
    registerPendingWrite("conv_write_1", "ag_1", "run_write_1", "a.txt", "/ws/a.txt", null, "x");
    registerPendingWrite("conv_write_1", "ag_1", "run_write_1", "b.txt", "/ws/b.txt", null, "y");
    registerPendingWrite("conv_write_1", "ag_1", "run_write_2", "c.txt", "/ws/c.txt", null, "z");

    cancelPendingWritesForRun("run_write_1");
    expect(getAllPendingWrites()).toHaveLength(1);
  });
});

describe("pending-bash", () => {
  it("registers a pending bash command", () => {
    const promise = registerPendingBash("conv_bash_1", "ag_1", "run_bash_1", "npm install", "/ws", "Installing dependencies");
    expect(promise).toBeInstanceOf(Promise);
  });

  it("lists all registered bash commands", () => {
    registerPendingBash("conv_bash_1", "ag_1", "run_bash_1", "npm install", "/ws", "Dep install");
    registerPendingBash("conv_bash_2", "ag_2", "run_bash_2", "git reset", "/ws2", "Reset");

    expect(getAllPendingBashCommands()).toHaveLength(2);
  });

  it("filters bash commands by conversation", () => {
    registerPendingBash("conv_bash_1", "ag_1", "run_bash_1", "npm install", "/ws", "Dep");
    registerPendingBash("conv_bash_2", "ag_2", "run_bash_2", "pip install", "/ws2", "Pip");

    const filtered = getPendingBashCommandsForConversation("conv_bash_2");
    expect(filtered).toHaveLength(1);
    expect(filtered[0].command).toBe("pip install");
  });

  it("approval resolves the promise with true", async () => {
    const promise = registerPendingBash("conv_bash_1", "ag_1", "run_bash_1", "npm install", "/ws", "Reason");

    setTimeout(() => {
      const all = getAllPendingBashCommands();
      approvePendingBash(all[0].id);
    }, 10);

    const result = await promise;
    expect(result).toBe(true);
  });

  it("allows a pending bash command to be resolved only once", async () => {
    const promise = registerPendingBash("conv_bash_1", "ag_1", "run_bash_1", "npm install", "/ws", "Reason");
    const id = getAllPendingBashCommands()[0].id;

    expect(approvePendingBash(id)).toBe(true);
    expect(rejectPendingBash(id)).toBe(false);
    await expect(promise).resolves.toBe(true);
  });

  it("rejection resolves the promise with false", async () => {
    const promise = registerPendingBash("conv_bash_1", "ag_1", "run_bash_1", "rm -rf node_modules", "/ws", "Clean");

    setTimeout(() => {
      const all = getAllPendingBashCommands();
      rejectPendingBash(all[0].id);
    }, 10);

    const result = await promise;
    expect(result).toBe(false);
  });

  it("cancelPendingBashForRun removes bash commands for a run", () => {
    registerPendingBash("conv_bash_1", "ag_1", "run_bash_1", "cmd1", "/ws", "r1");
    registerPendingBash("conv_bash_1", "ag_1", "run_bash_1", "cmd2", "/ws", "r2");
    registerPendingBash("conv_bash_1", "ag_1", "run_bash_2", "cmd3", "/ws", "r3");

    cancelPendingBashForRun("run_bash_1");
    expect(getAllPendingBashCommands()).toHaveLength(1);
  });
});

describe("approval operator attribution", () => {
  it("records the operator in resolved_by instead of the status", async () => {
    const promise = registerPendingBash("conv_op_1", "ag_1", "run_op_1", "npm install", "/ws", "Reason");
    const id = getAllPendingBashCommands()[0].id;

    // The module API is (identity, label): a principal in the identity slot,
    // the display string in the label slot (#24).
    expect(approvePendingBash(id, "feishu:cli_pm:ou_feishu_operator_1", "灰灰")).toBe(true);
    await promise;

    const record = getApprovalRecord(id);
    expect(record?.status).toBe("approved");
    expect(record?.resolvedBy).toBe("feishu:cli_pm:ou_feishu_operator_1");
    expect(record?.resolvedByLabel).toBe("灰灰");
    // Regression: the column used to be written with the *status* value.
    expect(record?.resolvedBy).not.toBe("approved");
    expect(typeof record?.resolvedAt).toBe("number");
  });

  it("leaves resolved_by NULL when the operator is unknown", async () => {
    const promise = registerPendingBash("conv_op_2", "ag_1", "run_op_2", "npm install", "/ws", "Reason");
    const id = getAllPendingBashCommands()[0].id;

    expect(approvePendingBash(id)).toBe(true);
    await promise;

    const record = getApprovalRecord(id);
    expect(record?.status).toBe("approved");
    expect(record?.resolvedBy).toBeNull();
    expect(record?.resolvedBy).not.toBe("approved");
  });

  it("records the operator on rejection", () => {
    registerPendingBash("conv_op_3", "ag_1", "run_op_3", "rm -rf /", "/ws", "Reason");
    const id = getAllPendingBashCommands()[0].id;

    expect(rejectPendingBash(id, "feishu:cli_pm:ou_feishu_operator_2")).toBe(true);

    const record = getApprovalRecord(id);
    expect(record?.status).toBe("rejected");
    expect(record?.resolvedBy).toBe("feishu:cli_pm:ou_feishu_operator_2");
    expect(record?.resolvedBy).not.toBe("rejected");
  });

  it("records the operator for write approvals too", () => {
    registerPendingWrite("conv_op_4", "ag_1", "run_op_4", "a.txt", "/ws/a.txt", null, "x");
    const id = getAllPendingWrites()[0].id;

    expect(approvePendingWrite(id, "feishu:cli_pm:ou_feishu_operator_3")).toBe(true);
    expect(getApprovalRecord(id)?.resolvedBy).toBe("feishu:cli_pm:ou_feishu_operator_3");
  });

  it("trims the operator and bounds its length", () => {
    registerPendingBash("conv_op_5", "ag_1", "run_op_5", "cmd", "/ws", "Reason");
    const id = getAllPendingBashCommands()[0].id;

    expect(approvePendingBash(id, `  ${"x".repeat(MAX_RESOLVED_BY_LENGTH + 50)}  `)).toBe(true);

    const record = getApprovalRecord(id);
    expect(record?.resolvedBy).toHaveLength(MAX_RESOLVED_BY_LENGTH);
    expect(record?.resolvedBy).not.toContain(" ");
  });

  it("treats a blank operator as unknown", () => {
    registerPendingBash("conv_op_6", "ag_1", "run_op_6", "cmd", "/ws", "Reason");
    const id = getAllPendingBashCommands()[0].id;

    expect(approvePendingBash(id, "   ")).toBe(true);

    expect(getApprovalRecord(id)?.resolvedBy).toBeNull();
  });

  it("attributes runtime-driven teardown rejections to the system", () => {
    registerPendingBash("conv_op_7", "ag_1", "run_op_7", "cmd", "/ws", "Reason");
    const id = getAllPendingBashCommands()[0].id;

    clearPendingBashForTests();

    expect(getApprovalRecord(id)?.resolvedBy).toBe(SYSTEM_RESOLVED_BY);
  });

  it("returns undefined for an unknown approval id", () => {
    expect(getApprovalRecord("pa_does_not_exist")).toBeUndefined();
  });

  it("still lets only the first decision win, and keeps the first operator", () => {
    registerPendingBash("conv_op_8", "ag_1", "run_op_8", "cmd", "/ws", "Reason");
    const id = getAllPendingBashCommands()[0].id;

    expect(approvePendingBash(id, "ou_first")).toBe(true);
    expect(rejectPendingBash(id, "ou_second")).toBe(false);

    const record = getApprovalRecord(id);
    expect(record?.status).toBe("approved");
    expect(record?.resolvedBy).toBe("ou_first");
  });

  it("does not overwrite the operator when the same row is resolved twice at the DB level", () => {
    registerPendingBash("conv_op_9", "ag_1", "run_op_9", "cmd", "/ws", "Reason");
    const id = getAllPendingBashCommands()[0].id;

    expect(resolveApproval(id, true, 1000, "ou_first")).toBe(true);
    expect(resolveApproval(id, false, 2000, "ou_second")).toBe(false);

    const record = getApprovalRecord(id);
    expect(record?.status).toBe("approved");
    expect(record?.resolvedBy).toBe("ou_first");
    expect(record?.resolvedAt).toBe(1000);
  });
});

describe("terminal approvals nobody decided", () => {
  it("records when a cancel happened, and leaves the operator null", () => {
    registerPendingBash("conv_c1", "ag_1", "run_c1", "cmd", "/ws", "Reason");
    const id = getAllPendingBashCommands()[0].id;

    cancelPendingBashForRun("run_c1");

    const record = getApprovalRecord(id);
    expect(record?.status).toBe("cancelled");
    // Nobody decided, so there is no operator — the status tells the story.
    expect(record?.resolvedBy).toBeNull();
    // resolvedAt means "stopped being pending", for any reason.
    expect(typeof record?.resolvedAt).toBe("number");
  });

  it("records when a startup interruption happened, and leaves the operator null", () => {
    registerPendingBash("conv_c2", "ag_1", "run_c2", "cmd", "/ws", "Reason");
    const id = getAllPendingBashCommands()[0].id;

    interruptAllPendingApprovals(54321);

    const record = getApprovalRecord(id);
    expect(record?.status).toBe("interrupted");
    expect(record?.resolvedBy).toBeNull();
    expect(record?.resolvedAt).toBe(54321);
  });
});

describe("legacy approval record repair", () => {
  function insertApproval(
    id: string,
    status: string,
    resolvedBy: string | null,
    resolvedAt: number | null = Date.now()
  ): void {
    const now = Date.now();
    getDatabase()
      .prepare(`
        INSERT INTO pending_approvals
          (id, conversation_id, agent_id, run_id, approval_type, status, payload_json,
           resolved_by, resolved_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(id, "conv_legacy", "ag_1", "run_legacy", "bash", status, "{}", resolvedBy, resolvedAt, now, now);
  }

  it("clears only the rows where the old bug copied the status into resolved_by", () => {
    // Exactly the shape the old statement produced: the same value in both
    // columns.
    insertApproval("pa_corrupt_approved", "approved", "approved");
    insertApproval("pa_corrupt_rejected", "rejected", "rejected");
    // A real operator whose name differs from the status: must survive.
    insertApproval("pa_real_operator", "rejected", "ou_real");
    // An operator genuinely named "approved" on a rejection: `resolved_by`
    // differs from `status`, so the narrow predicate spares it too.
    insertApproval("pa_ambiguous", "rejected", "approved");
    // Cancellation never wrote this column, so a cancelled row whose label
    // happens to repeat the status is not the bug's output and is left alone.
    insertApproval("pa_cancelled", "cancelled", "cancelled");

    resetBootstrapForTests();
    ensureDatabase();

    expect(getApprovalRecord("pa_corrupt_approved")?.resolvedBy).toBeNull();
    expect(getApprovalRecord("pa_corrupt_rejected")?.resolvedBy).toBeNull();
    expect(getApprovalRecord("pa_real_operator")?.resolvedBy).toBe("ou_real");
    expect(getApprovalRecord("pa_ambiguous")?.resolvedBy).toBe("approved");
    expect(getApprovalRecord("pa_cancelled")?.resolvedBy).toBe("cancelled");
  });

  it("backfills resolved_at for terminal rows that never had one", () => {
    // Cancellation and interruption used to leave the timestamp NULL, which
    // contradicts what the column is documented to mean.
    insertApproval("pa_cancel_no_ts", "cancelled", null, null);
    insertApproval("pa_interrupt_no_ts", "interrupted", null, null);
    // A row that already has one must keep it.
    insertApproval("pa_has_ts", "approved", "ou_real", 4242);
    // A 'pending' row is not terminal, but it cannot be observed as pending
    // after a bootstrap: recovery interrupts every pending approval first, so by
    // the time we look it is 'interrupted' and carries a timestamp.
    insertApproval("pa_still_pending", "pending", null, null);

    resetBootstrapForTests();
    ensureDatabase();

    expect(typeof getApprovalRecord("pa_cancel_no_ts")?.resolvedAt).toBe("number");
    expect(typeof getApprovalRecord("pa_interrupt_no_ts")?.resolvedAt).toBe("number");
    expect(getApprovalRecord("pa_has_ts")?.resolvedAt).toBe(4242);
    expect(getApprovalRecord("pa_still_pending")?.status).toBe("interrupted");
    expect(typeof getApprovalRecord("pa_still_pending")?.resolvedAt).toBe("number");
  });
});
