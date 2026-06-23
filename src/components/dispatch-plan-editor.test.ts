import { describe, expect, it } from "vitest";
import { validatePlan } from "@/components/dispatch-plan-editor";
import type { Agent, Conversation, DispatchPlanItem } from "@/shared/types";

const worker = createAgent("ag_worker", false);
const conductor = createAgent("ag_conductor", true);
const agents = { [worker.id]: worker, [conductor.id]: conductor };
const conversation: Conversation = {
  id: "conv_test",
  title: "Test",
  mode: "group",
  agentIds: [conductor.id, worker.id],
  fsWriteApprovalMode: "review",
  pinnedMessageIds: [],
  pinnedAt: null,
  archived: false,
  createdAt: 1,
  updatedAt: 1
};

describe("validatePlan", () => {
  it("accepts a valid worker DAG", () => {
    const plan: DispatchPlanItem[] = [
      {
        id: "t1",
        agentId: worker.id,
        task: "Build the feature",
        dependsOn: [],
        acceptanceCriteria: ["Build passes"],
        expectedOutputs: [{ id: "app", type: "web_app" }]
      },
      {
        id: "t2",
        agentId: worker.id,
        task: "Review the feature",
        dependsOn: ["t1"],
        acceptanceCriteria: ["Review complete"]
      }
    ];
    expect(validatePlan(plan, agents, conversation)).toEqual([]);
  });

  it("rejects conductor assignment and dependency cycles", () => {
    const plan: DispatchPlanItem[] = [
      {
        id: "t1",
        agentId: conductor.id,
        task: "Invalid",
        dependsOn: ["t2"],
        acceptanceCriteria: ["Done"]
      },
      {
        id: "t2",
        agentId: worker.id,
        task: "Invalid",
        dependsOn: ["t1"],
        acceptanceCriteria: ["Done"]
      }
    ];
    const errors = validatePlan(plan, agents, conversation);
    expect(errors.some((error) => error.includes("Conductor"))).toBe(true);
    expect(errors.some((error) => error.includes("循环"))).toBe(true);
  });
});

function createAgent(id: string, isConductor: boolean): Agent {
  return {
    id,
    name: id,
    avatar: "A",
    description: "",
    capabilities: [],
    adapterName: "custom",
    modelProvider: "deepseek",
    modelId: "deepseek-chat",
    apiKey: null,
    apiBaseUrl: null,
    systemPrompt: "",
    toolNames: [],
    isBuiltin: true,
    isConductor,
    supportsVision: false,
    createdAt: 1,
    updatedAt: 1
  };
}
