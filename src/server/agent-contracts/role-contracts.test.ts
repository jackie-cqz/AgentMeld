// ---------------------------------------------------------------------------
// P5: Role Contracts tests
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import {
  getRoleContract, detectAgentRole, getAllRoleContracts,
  PM_CONTRACT, UI_CONTRACT, FRONTEND_CONTRACT, REVIEWER_CONTRACT,
} from "@/server/agent-contracts/role-contracts";
import { applyRoleContracts, buildContractGuidance } from "@/server/agent-contracts/contract-resolver";
import type { DispatchPlanItem } from "@/shared/types";

describe("role-contracts", () => {
  it("has 4 standard contracts", () => {
    const all = getAllRoleContracts();
    expect(all.length).toBe(4);
  });

  it("PM contract requires no inputs", () => {
    expect(PM_CONTRACT.requiredInputs).toEqual([]);
    expect(PM_CONTRACT.outputKey).toBe("prd");
  });

  it("UI contract requires prd input", () => {
    expect(UI_CONTRACT.requiredInputs).toContain("prd");
    expect(UI_CONTRACT.outputKey).toBe("style-guide");
  });

  it("Frontend contract requires prd + style-guide", () => {
    expect(FRONTEND_CONTRACT.requiredInputs).toContain("prd");
    expect(FRONTEND_CONTRACT.requiredInputs).toContain("style-guide");
    expect(FRONTEND_CONTRACT.outputKey).toBe("web_app");
  });

  it("Reviewer contract requires all upstream outputs", () => {
    expect(REVIEWER_CONTRACT.requiredInputs).toContain("prd");
    expect(REVIEWER_CONTRACT.requiredInputs).toContain("style-guide");
    expect(REVIEWER_CONTRACT.requiredInputs).toContain("web_app");
  });
});

describe("detectAgentRole", () => {
  it("detects pm from capabilities", () => {
    expect(detectAgentRole(["pm", "planning"])).toBe("pm");
  });

  it("detects ui from designer capability", () => {
    expect(detectAgentRole(["design", "ux"])).toBe("ui");
  });

  it("detects frontend from react capability", () => {
    expect(detectAgentRole(["react", "typescript"])).toBe("frontend");
  });

  it("detects reviewer from review capability", () => {
    expect(detectAgentRole(["review"])).toBe("reviewer");
  });

  it("returns null for unknown role", () => {
    expect(detectAgentRole(["unknown"])).toBeNull();
  });
});

describe("applyRoleContracts", () => {
  const agents = [
    { id: "ag_pm", name: "PM", capabilities: ["pm"] },
    { id: "ag_designer", name: "UI Designer", capabilities: ["design"] },
    { id: "ag_builder", name: "Frontend", capabilities: ["react"] },
    { id: "ag_reviewer", name: "Reviewer", capabilities: ["review"] },
  ];

  // Realistic plan where task.id ≠ agent.id — tasks reference agents by agentId.
  // The input matching must resolve depId(t1) → task.agentId(ag_pm) → agent role(pm).
  const fullPlan: DispatchPlanItem[] = [
    { id: "t1", agentId: "ag_pm", task: "write PRD", dependsOn: [], expectedOutputs: [], inputs: [], acceptanceCriteria: [] },
    { id: "t2", agentId: "ag_designer", task: "design UI", dependsOn: ["t1"], expectedOutputs: [], inputs: [], acceptanceCriteria: [] },
    { id: "t3", agentId: "ag_builder", task: "build app", dependsOn: ["t1", "t2"], expectedOutputs: [], inputs: [], acceptanceCriteria: [] },
  ];

  it("auto-fills expectedOutputs for frontend task", () => {
    const result = applyRoleContracts(fullPlan, agents);
    const t3 = result.plan.find((t) => t.id === "t3")!;
    expect(result.enriched).toBe(true);
    expect(t3.expectedOutputs!.length).toBeGreaterThan(0);
    expect(t3.expectedOutputs![0].id).toBe("web_app");
  });

  it("does not require pnpm build by default for frontend tasks", () => {
    const result = applyRoleContracts(fullPlan, agents);
    const t3 = result.plan.find((t) => t.id === "t3")!;
    const criteria = (t3.acceptanceCriteria ?? []).map((criterion) =>
      typeof criterion === "string" ? JSON.parse(criterion) : criterion
    );

    expect(criteria.some((criterion) => criterion.validator?.type === "command_exit")).toBe(false);
    expect(criteria.some((criterion) => criterion.validator?.type === "artifact_exists")).toBe(true);
    expect(criteria.some((criterion) => criterion.validator?.type === "deployment_created")).toBe(true);
  });

  it("generates stable unique contract criterion ids", () => {
    const result = applyRoleContracts(fullPlan, agents);
    const t3 = result.plan.find((t) => t.id === "t3")!;
    const criteria = (t3.acceptanceCriteria ?? []).map((criterion) =>
      typeof criterion === "string" ? JSON.parse(criterion) : criterion
    );
    const ids = criteria
      .filter((criterion) => typeof criterion.id === "string" && criterion.id.startsWith("contract-"))
      .map((criterion) => criterion.id);

    expect(ids).toContain("contract-artifact-web_app-web_app");
    expect(ids).toContain("contract-deployment-web_app");
    expect(ids).not.toContain("contract-----");
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("auto-fills inputs by agent role (not positional order)", () => {
    const result = applyRoleContracts(fullPlan, agents);
    const t3 = result.plan.find((t) => t.id === "t3")!;
    expect(result.enriched).toBe(true);
    expect(t3.inputs!.length).toBe(2);
    expect(t3.inputs!.some((i) => i.fromTaskId === "t1" && i.outputId === "prd")).toBe(true);
    expect(t3.inputs!.some((i) => i.fromTaskId === "t2" && i.outputId === "style-guide")).toBe(true);
  });

  it("handles reversed dependency order via role matching", () => {
    const reversedPlan: DispatchPlanItem[] = [
      { id: "t1", agentId: "ag_pm", task: "write PRD", dependsOn: [], expectedOutputs: [], inputs: [], acceptanceCriteria: [] },
      { id: "t2", agentId: "ag_designer", task: "design UI", dependsOn: ["t1"], expectedOutputs: [], inputs: [], acceptanceCriteria: [] },
      { id: "t3", agentId: "ag_builder", task: "build app", dependsOn: ["t2", "t1"], expectedOutputs: [], inputs: [], acceptanceCriteria: [] },
    ];
    const result = applyRoleContracts(reversedPlan, agents);
    const t3 = result.plan.find((t) => t.id === "t3")!;
    expect(t3.inputs!.some((i) => i.fromTaskId === "t1" && i.outputId === "prd")).toBe(true);
    expect(t3.inputs!.some((i) => i.fromTaskId === "t2" && i.outputId === "style-guide")).toBe(true);
  });

  it("does not create spurious input pairings", () => {
    const result = applyRoleContracts(fullPlan, agents);
    const t3 = result.plan.find((t) => t.id === "t3")!;
    expect(t3.inputs!.some((i) => i.fromTaskId === "t1" && i.outputId === "style-guide")).toBe(false);
    expect(t3.inputs!.some((i) => i.fromTaskId === "t2" && i.outputId === "prd")).toBe(false);
  });

  it("does not overwrite existing outputs", () => {
    const customPlan: DispatchPlanItem[] = [
      { id: "t1", agentId: "ag_pm", task: "write PRD", dependsOn: [], expectedOutputs: [{ id: "custom_prd", type: "document" as const }], inputs: [], acceptanceCriteria: [] },
    ];
    const result = applyRoleContracts(customPlan, agents);
    expect(result.plan[0].expectedOutputs!.some((o) => o.id === "custom_prd")).toBe(true);
  });

  it("returns not enriched for unknown agents", () => {
    const unknownPlan: DispatchPlanItem[] = [
      { id: "tx", agentId: "ag_unknown", task: "do stuff", dependsOn: [], expectedOutputs: [], inputs: [], acceptanceCriteria: [] },
    ];
    const { enriched } = applyRoleContracts(unknownPlan, []);
    expect(enriched).toBe(false);
  });
});

describe("buildContractGuidance", () => {
  it("generates guidance text for known roles", () => {
    const agents = [{ id: "ag_pm", name: "PM", capabilities: ["pm"] }];
    const guidance = buildContractGuidance(agents);
    expect(guidance).toContain("标准角色输出协议");
    expect(guidance).toContain("prd");
    expect(guidance).toContain("ag_pm");
  });

  it("returns empty for no matching roles", () => {
    expect(buildContractGuidance([])).toBe("");
  });
});
