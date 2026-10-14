import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  approvePlan,
  cancelPendingPlansForRun,
  clearPendingPlansForTests,
  getAllPendingPlans,
  getPendingPlan,
  getPendingPlansForConversation,
  registerPendingPlan,
  rejectPlan,
  revisePlanWithFeedback
} from "@/server/dispatch-plan-manager";
import type { DispatchPlanItem } from "@/shared/types";
import { getDatabase } from "@/db/client";
import { createConversation, createRun } from "@/server/repositories";
import { setupTestDatabase } from "@/test/test-database";

let cleanupDatabase: (() => void) | undefined;

beforeAll(() => {
  cleanupDatabase = setupTestDatabase("agentmeld-dispatch-plans-");
});

afterAll(() => {
  cleanupDatabase?.();
});

afterEach(() => {
  clearPendingPlansForTests();
});

const samplePlan: DispatchPlanItem[] = [
  { id: "t1", agentId: "ag_1", task: "Do task 1", dependsOn: [] },
  { id: "t2", agentId: "ag_2", task: "Do task 2", dependsOn: ["t1"] }
];

describe("dispatch-plan-manager", () => {
  it("registers a pending plan", () => {
    const promise = registerPendingPlan("conv_plan_1", "run_plan_1", samplePlan);
    expect(promise).toBeInstanceOf(Promise);
    expect(getAllPendingPlans()).toHaveLength(1);
  });

  it("filters plans by conversation", () => {
    registerPendingPlan("conv_plan_1", "run_plan_1", samplePlan);
    registerPendingPlan("conv_plan_2", "run_plan_2", []);

    expect(getPendingPlansForConversation("conv_plan_1")).toHaveLength(1);
    expect(getPendingPlansForConversation("conv_plan_2")).toHaveLength(1);
    expect(getPendingPlansForConversation("conv_plan_3")).toHaveLength(0);
  });

  it("approving resolves the promise with approved=true", async () => {
    const promise = registerPendingPlan("conv_plan_1", "run_plan_1", samplePlan);

    setTimeout(() => {
      const plans = getAllPendingPlans();
      approvePlan(plans[0].id);
    }, 10);

    const result = await promise;
    expect(result.approved).toBe(true);
    expect(getAllPendingPlans()).toHaveLength(0);
  });

  it("allows a pending plan to be resolved only once", async () => {
    const promise = registerPendingPlan("conv_plan_1", "run_plan_1", samplePlan);
    const id = getAllPendingPlans()[0].id;

    expect(approvePlan(id)).toBe(true);
    expect(rejectPlan(id)).toBe(false);
    await expect(promise).resolves.toEqual({ approved: true });
  });

  it("rejecting resolves the promise with approved=false", async () => {
    const promise = registerPendingPlan("conv_plan_1", "run_plan_1", samplePlan);

    setTimeout(() => {
      const plans = getAllPendingPlans();
      rejectPlan(plans[0].id);
    }, 10);

    const result = await promise;
    expect(result.approved).toBe(false);
  });

  it("revising returns feedback text", async () => {
    const promise = registerPendingPlan("conv_plan_1", "run_plan_1", samplePlan);

    setTimeout(() => {
      const plans = getAllPendingPlans();
      revisePlanWithFeedback(plans[0].id, "t3 is unnecessary, please remove.");
    }, 10);

    const result = await promise;
    expect(result.approved).toBe(true);
    expect(result.feedback).toBe("t3 is unnecessary, please remove.");
  });

  it("getPendingPlan returns undefined for unknown id", () => {
    expect(getPendingPlan("nonexistent")).toBeUndefined();
  });

  it("cancelPendingPlansForRun removes plans", () => {
    registerPendingPlan("conv_plan_1", "run_plan_1", samplePlan);
    registerPendingPlan("conv_plan_1", "run_plan_2", []);
    cancelPendingPlansForRun("run_plan_1");
    expect(getAllPendingPlans()).toHaveLength(1);
  });

  // Regression: the conductor's approval meta-attempt was inserted as 'running'
  // and never updated, so every approved plan left a permanently running attempt
  // behind (4/4 group tasks in a task-matrix run showed `conductor: running`).
  it("records the conductor approval meta-attempt as already finished", async () => {
    // task_attempts.conductor_run_id references agent_runs, so the run has to exist.
    const now = Date.now();
    createConversation({ id: "conv_plan_meta", title: "plan meta", mode: "single", agentIds: ["ag_pm"], fsWriteApprovalMode: "auto", now });
    createRun({ id: "run_plan_meta", conversationId: "conv_plan_meta", agentId: "ag_pm", triggerMessageId: null, parentRunId: null, status: "running", now });

    const promise = registerPendingPlan("conv_plan_meta", "run_plan_meta", samplePlan);

    setTimeout(() => {
      approvePlan(getAllPendingPlans()[0].id);
    }, 10);
    await promise;

    const row = getDatabase()
      .prepare("SELECT execution_status, finished_at FROM task_attempts WHERE task_id = 'conductor' AND conductor_run_id = ?")
      .get("run_plan_meta") as { execution_status: string; finished_at: number | null } | undefined;

    expect(row).toBeDefined();
    expect(row?.execution_status).toBe("reported_complete");
    expect(row?.finished_at).not.toBeNull();
  });

  // Regression guard for rows written by the OLD pending-questions.ts, which
  // inserted this same row id as 'running' before the plan was approved. An
  // INSERT OR IGNORE at approval time was therefore ignored and the row stayed
  // running forever — the exact case the fix above missed. pending-questions.ts
  // now writes the row terminal itself, so this seeds the legacy shape directly
  // to keep the approval path able to repair rows already in a user's database.
  it("finishes a conductor meta-attempt that a pending question created first", async () => {
    const now = Date.now();
    createConversation({ id: "conv_plan_q", title: "plan q", mode: "single", agentIds: ["ag_pm"], fsWriteApprovalMode: "auto", now });
    createRun({ id: "run_plan_q", conversationId: "conv_plan_q", agentId: "ag_pm", triggerMessageId: null, parentRunId: null, status: "running", now });

    // What pending-questions.ts writes when the Conductor asks before planning.
    const metaId = "ta_conductor_plan_run_plan_q_init";
    getDatabase()
      .prepare(
        `INSERT INTO task_attempts (id, conductor_run_id, conversation_id, plan_id, plan_revision, task_id, agent_id, attempt, execution_status, verification_status, created_at, updated_at)
         VALUES (?, 'run_plan_q', 'conv_plan_q', 'plan_run_plan_q_init', 0, 'conductor', 'conductor', 0, 'running', 'not_started', ?, ?)`
      )
      .run(metaId, now, now);

    const promise = registerPendingPlan("conv_plan_q", "run_plan_q", samplePlan);
    setTimeout(() => {
      approvePlan(getAllPendingPlans()[0].id);
    }, 10);
    await promise;

    const row = getDatabase()
      .prepare("SELECT execution_status, finished_at FROM task_attempts WHERE id = ?")
      .get(metaId) as { execution_status: string; finished_at: number | null } | undefined;

    expect(row?.execution_status).toBe("reported_complete");
    expect(row?.finished_at).not.toBeNull();
  });
});
