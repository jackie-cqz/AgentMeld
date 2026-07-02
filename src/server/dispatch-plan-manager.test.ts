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
});
