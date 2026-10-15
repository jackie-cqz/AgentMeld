import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensureDatabase, resetBootstrapForTests } from "@/db/bootstrap";
import { getDatabase, resetDatabaseForTests } from "@/db/client";
import { eventBus } from "@/server/event-bus";
import {
  MAX_OUTSTANDING_GRANTS_PER_RUN,
  clearDelegationsForTests,
  consumeDelegation,
  getDelegationByCorrelationId,
  issueDelegation
} from "@/server/delegation";

let tempDir: string;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentmeld-delegation-"));
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

const base = {
  sourceRunId: "run_parent",
  sourceAgentId: "ag_conductor",
  targetAgentId: "ag_builder",
  taskId: "task_1",
  attempt: 1,
  sourceRunStatus: "running"
};

function issue(overrides: Partial<typeof base> = {}) {
  const result = issueDelegation({ ...base, ...overrides });
  if (!result.ok) throw new Error(`issue failed: ${result.error}`);
  return result.correlationId;
}

describe("issuing", () => {
  it("mints a grant that names exactly the delegation it authorizes", () => {
    const correlationId = issue();
    const grant = getDelegationByCorrelationId(correlationId);
    expect(grant).toMatchObject({
      sourceRunId: "run_parent",
      sourceAgentId: "ag_conductor",
      targetAgentId: "ag_builder",
      taskId: "task_1",
      attempt: 1,
      status: "issued",
      consumedByRunId: null
    });
  });

  it("stores only a hash of the correlation id", () => {
    // The id is a bearer capability: it is handed out once and must not be
    // readable back out of the database.
    const correlationId = issue();
    const rows = getDatabase().prepare("SELECT correlation_id FROM delegations").all() as Array<{
      correlation_id: string;
    }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].correlation_id).not.toBe(correlationId);
    expect(rows[0].correlation_id).toMatch(/^[0-9a-f]{64}$/);
  });

  it("refuses to mint for a run that is not running", () => {
    // State is checked where the context still exists, not trusted from the
    // caller's intent: a finished parent must not spawn work.
    for (const status of ["complete", "failed", "aborted"]) {
      const result = issueDelegation({ ...base, sourceRunStatus: status });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe("not_running");
    }
    expect(getDatabase().prepare("SELECT COUNT(*) AS count FROM delegations").get()).toMatchObject({ count: 0 });
  });

  it("refuses an incomplete delegation rather than minting a loose one", () => {
    const result = issueDelegation({ ...base, targetAgentId: "" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("invalid");
  });

  it("caps how many unconsumed grants one run may hold", () => {
    for (let i = 0; i < MAX_OUTSTANDING_GRANTS_PER_RUN; i++) {
      issue({ taskId: `task_${i}` });
    }
    const extra = issueDelegation({ ...base, taskId: "task_overflow" });
    expect(extra.ok).toBe(false);
    if (!extra.ok) expect(extra.code).toBe("budget_exhausted");
  });

  it("frees a budget slot when a grant is consumed", () => {
    const ids: string[] = [];
    for (let i = 0; i < MAX_OUTSTANDING_GRANTS_PER_RUN; i++) {
      ids.push(issue({ taskId: `task_${i}` }));
    }
    expect(issueDelegation({ ...base, taskId: "task_overflow" }).ok).toBe(false);

    const consumed = consumeDelegation({
      correlationId: ids[0],
      sourceRunId: base.sourceRunId,
      targetAgentId: base.targetAgentId,
      taskId: "task_0",
      attempt: 1
    });
    expect(consumed.ok).toBe(true);

    expect(issue({ taskId: "task_after" })).toBeTruthy();
  });
});

describe("consuming", () => {
  it("spends a grant exactly once", () => {
    const correlationId = issue();
    const first = consumeDelegation({
      correlationId,
      sourceRunId: base.sourceRunId,
      targetAgentId: base.targetAgentId,
      taskId: base.taskId,
      attempt: base.attempt,
      childRunId: "run_child"
    });
    expect(first.ok).toBe(true);
    if (first.ok) expect(first.grant.consumedByRunId).toBe("run_child");

    const replay = consumeDelegation({
      correlationId,
      sourceRunId: base.sourceRunId,
      targetAgentId: base.targetAgentId,
      taskId: base.taskId,
      attempt: base.attempt
    });
    expect(replay.ok).toBe(false);
    if (!replay.ok) expect(replay.code).toBe("consumed");
  });

  it("lets only one of two concurrent spends win", () => {
    const correlationId = issue();
    const attempt = () =>
      consumeDelegation({
        correlationId,
        sourceRunId: base.sourceRunId,
        targetAgentId: base.targetAgentId,
        taskId: base.taskId,
        attempt: base.attempt
      });
    const results = [attempt(), attempt()];
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok && r.code === "consumed")).toHaveLength(1);
  });

  it("refuses a grant issued for another task, agent, attempt or run", () => {
    const correlationId = issue();
    const mismatches = [
      { taskId: "task_other" },
      { targetAgentId: "ag_other" },
      { attempt: 2 },
      { sourceRunId: "run_other" }
    ];
    for (const mismatch of mismatches) {
      const result = consumeDelegation({
        correlationId,
        sourceRunId: base.sourceRunId,
        targetAgentId: base.targetAgentId,
        taskId: base.taskId,
        attempt: base.attempt,
        ...mismatch
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe("mismatch");
    }
    // A refused attempt must NOT burn the grant: the real delegation can still
    // start afterwards.
    const real = consumeDelegation({
      correlationId,
      sourceRunId: base.sourceRunId,
      targetAgentId: base.targetAgentId,
      taskId: base.taskId,
      attempt: base.attempt
    });
    expect(real.ok).toBe(true);
  });

  it("refuses an expired grant and marks it expired", () => {
    const now = Date.now();
    const correlationId = issue();
    // Backdate the grant past its TTL, as time passing would.
    getDatabase().prepare("UPDATE delegations SET expires_at = ?").run(now - 1);

    const result = consumeDelegation({
      correlationId,
      sourceRunId: base.sourceRunId,
      targetAgentId: base.targetAgentId,
      taskId: base.taskId,
      attempt: base.attempt,
      now
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("expired");
    expect(getDelegationByCorrelationId(correlationId)?.status).toBe("expired");
  });

  it("refuses an unknown correlation id", () => {
    const result = consumeDelegation({
      correlationId: "not-a-real-grant",
      sourceRunId: base.sourceRunId,
      targetAgentId: base.targetAgentId,
      taskId: base.taskId,
      attempt: base.attempt
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("unknown");
    // Nothing was written for it — a probe leaves no row behind.
    expect(getDelegationByCorrelationId("not-a-real-grant")).toBeUndefined();
  });
});
