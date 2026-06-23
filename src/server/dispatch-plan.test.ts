import { describe, expect, it } from "vitest";
import { compileAndValidateDispatchPlan } from "@/server/dispatch-plan";

describe("compileAndValidateDispatchPlan", () => {
  it("preserves task metadata and maxAttempts", () => {
    const result = compileAndValidateDispatchPlan(
      [{
        id: "t1",
        agentId: "ag_worker",
        title: "Implement",
        prompt: "Implement the feature",
        dependsOn: [],
        maxAttempts: 3,
        expectedOutputs: [{ id: "app", type: "web_app", required: true }]
      }],
      ["ag_conductor", "ag_worker"],
      "ag_conductor"
    );

    expect(typeof result).not.toBe("string");
    if (typeof result !== "string") {
      expect(result[0]).toMatchObject({
        title: "Implement",
        task: "Implement the feature",
        maxAttempts: 3
      });
    }
  });

  it("allows recovery tasks to depend on completed tasks from an earlier round", () => {
    const result = compileAndValidateDispatchPlan(
      [{
        id: "r1",
        agentId: "ag_worker",
        prompt: "Repair the implementation",
        dependsOn: ["t1"]
      }],
      ["ag_conductor", "ag_worker"],
      "ag_conductor",
      ["t1"]
    );

    expect(typeof result).not.toBe("string");
    if (typeof result !== "string") {
      expect(result[0].dependsOn).toEqual(["t1"]);
    }
  });

  it("still rejects unknown dependencies", () => {
    const result = compileAndValidateDispatchPlan(
      [{
        id: "t1",
        agentId: "ag_worker",
        prompt: "Implement",
        dependsOn: ["missing"]
      }],
      ["ag_conductor", "ag_worker"],
      "ag_conductor"
    );

    expect(result).toContain("unknown task");
  });
});
