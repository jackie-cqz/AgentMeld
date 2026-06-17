import { afterEach, describe, expect, it } from "vitest";
import {
  approvePlan,
  cancelPendingPlansForRun,
  clearPendingPlansForTests,
  getAllPendingPlans,
  getPendingPlan,
  getPendingPlansForConversation,
  registerPendingPlan,
  rejectPlan,
  revisePlan
} from "@/server/dispatch-plan-manager";
import type { DispatchPlanItem } from "@/shared/types";

afterEach(() => {
  clearPendingPlansForTests();
});

const samplePlan: DispatchPlanItem[] = [
  { id: "t1", agentId: "ag_1", task: "Do task 1", dependsOn: [] },
  { id: "t2", agentId: "ag_2", task: "Do task 2", dependsOn: ["t1"] }
];

describe("dispatch-plan-manager", () => {
  it("registers a pending plan", () => {
    const promise = registerPendingPlan("conv_1", "run_1", samplePlan);
    expect(promise).toBeInstanceOf(Promise);
    expect(getAllPendingPlans()).toHaveLength(1);
  });

  it("filters plans by conversation", () => {
    registerPendingPlan("conv_1", "run_1", samplePlan);
    registerPendingPlan("conv_2", "run_2", []);

    expect(getPendingPlansForConversation("conv_1")).toHaveLength(1);
    expect(getPendingPlansForConversation("conv_2")).toHaveLength(1);
    expect(getPendingPlansForConversation("conv_3")).toHaveLength(0);
  });

  it("approving resolves the promise with approved=true", async () => {
    const promise = registerPendingPlan("conv_1", "run_1", samplePlan);

    setTimeout(() => {
      const plans = getAllPendingPlans();
      approvePlan(plans[0].id);
    }, 10);

    const result = await promise;
    expect(result.approved).toBe(true);
    expect(getAllPendingPlans()).toHaveLength(0);
  });

  it("rejecting resolves the promise with approved=false", async () => {
    const promise = registerPendingPlan("conv_1", "run_1", samplePlan);

    setTimeout(() => {
      const plans = getAllPendingPlans();
      rejectPlan(plans[0].id);
    }, 10);

    const result = await promise;
    expect(result.approved).toBe(false);
  });

  it("revising returns the revised plan", async () => {
    const promise = registerPendingPlan("conv_1", "run_1", samplePlan);

    const revisedPlan: DispatchPlanItem[] = [
      { id: "t1", agentId: "ag_1", task: "Revised task", dependsOn: [] }
    ];

    setTimeout(() => {
      const plans = getAllPendingPlans();
      revisePlan(plans[0].id, revisedPlan);
    }, 10);

    const result = await promise;
    expect(result.approved).toBe(true);
    expect(result.revisedPlan).toEqual(revisedPlan);
  });

  it("getPendingPlan returns undefined for unknown id", () => {
    expect(getPendingPlan("nonexistent")).toBeUndefined();
  });

  it("cancelPendingPlansForRun removes plans", () => {
    registerPendingPlan("conv_1", "run_1", samplePlan);
    registerPendingPlan("conv_1", "run_2", []);
    cancelPendingPlansForRun("run_1");
    expect(getAllPendingPlans()).toHaveLength(1);
  });
});
