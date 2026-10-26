import { describe, expect, it } from "vitest";
import { compileAndValidateDispatchPlan, compileDispatchPlan, parseDispatchPlanToolArgs } from "@/server/dispatch-plan";
import type { DispatchPlanItem } from "@/shared/types";

describe("contract-based dependency compilation", () => {
  const task = (id: string, instruction: string): DispatchPlanItem => ({ id, agentId: "ag_worker", task: instruction, dependsOn: [] });
  it("does not serialize independent review/test tasks or match t1 inside t10", () => {
    const result = compileDispatchPlan([task("t1", "Create documentation"), task("t10", "Test the existing parser independently; label t10")]);
    expect(result[1].dependsOn).toEqual([]);
  });
  it("preserves explicit edges and derives required input edges even for later declarations", () => {
    const result = compileDispatchPlan([
      { ...task("consumer", "Use a verified upstream report"), dependsOn: ["setup"], inputs: [{ fromTaskId: "producer", outputId: "report", required: true }] },
      task("setup", "Prepare"), task("producer", "Produce report"),
    ]);
    expect(result[0].dependsOn).toEqual(["setup", "producer"]);
  });
  it("still rejects cycles induced by input contracts", () => {
    expect(compileAndValidateDispatchPlan([
      { id: "a", agentId: "worker", prompt: "A", inputs: [{ fromTaskId: "b", outputId: "output", required: true }], expectedOutputs: [{ id: "output", type: "document" }] },
      { id: "b", agentId: "worker", prompt: "B", inputs: [{ fromTaskId: "a", outputId: "output", required: true }], expectedOutputs: [{ id: "output", type: "document" }] },
    ], ["worker", "conductor"], "conductor")).toMatch(/circular/i);
  });
});

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
        taskIntent: "verification",
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
        maxAttempts: 3,
        taskIntent: "verification",
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

describe("parseDispatchPlanToolArgs acceptance criteria", () => {
  const contract = {
    id: "contract-artifact-prd-document",
    description: "PRD 产物已创建",
    required: true,
    validator: { type: "artifact_exists", outputKey: "prd", artifactType: "document" },
  };

  it("serializes a structured contract instead of printing [object Object]", () => {
    const [task] = parseDispatchPlanToolArgs({
      tasks: [{
        id: "t1",
        agentId: "ag_pm",
        task: "Write the PRD",
        acceptanceCriteria: ["文档完整", contract],
      }],
    });

    expect(task.acceptanceCriteria).toEqual(["文档完整", JSON.stringify(contract)]);
    expect(task.acceptanceCriteria?.join("\n")).not.toContain("[object Object]");
  });

  it("keeps an already-canonical JSON string untouched", () => {
    const serialized = JSON.stringify(contract);
    const [task] = parseDispatchPlanToolArgs({
      tasks: [{ id: "t1", agentId: "ag_pm", task: "Write the PRD", acceptanceCriteria: [serialized] }],
    });

    expect(task.acceptanceCriteria).toEqual([serialized]);
  });
});
