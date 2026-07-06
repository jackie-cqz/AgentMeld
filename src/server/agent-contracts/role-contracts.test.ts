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
    { id: "t1", name: "PM", capabilities: ["pm"] },
    { id: "t2", name: "UI Designer", capabilities: ["design"] },
    { id: "ag_builder", name: "Frontend", capabilities: ["react"] },
    { id: "ag_reviewer", name: "Reviewer", capabilities: ["review"] },
  ];

  it("auto-fills expectedOutputs for frontend task", () => {
    const plan: DispatchPlanItem[] = [
      { id: "t3", agentId: "ag_builder", task: "build app", dependsOn: ["t1", "t2"], expectedOutputs: [], inputs: [], acceptanceCriteria: [] },
    ];
    const result = applyRoleContracts(plan, agents);
    expect(result.enriched).toBe(true);
    expect(result.plan[0].expectedOutputs!.length).toBeGreaterThan(0);
    expect(result.plan[0].expectedOutputs![0].id).toBe("web_app");
  });

  it("auto-fills inputs by agent role (not positional order)", () => {
    // Frontend depends on t1(PM→prd) and t2(designer→style-guide).
    // Role-based matching: prd→t1(PM), style-guide→t2(UI)
    const plan: DispatchPlanItem[] = [
      { id: "t3", agentId: "ag_builder", task: "build app", dependsOn: ["t1", "t2"], expectedOutputs: [], inputs: [], acceptanceCriteria: [] },
    ];
    const result = applyRoleContracts(plan, agents);
    expect(result.enriched).toBe(true);
    expect(result.plan[0].inputs!.length).toBe(2);
    expect(result.plan[0].inputs!.some((i) => i.fromTaskId === "t1" && i.outputId === "prd")).toBe(true);
    expect(result.plan[0].inputs!.some((i) => i.fromTaskId === "t2" && i.outputId === "style-guide")).toBe(true);
  });

  it("handles reversed dependency order via role matching", () => {
    // Even if dependsOn is ["t2", "t1"], role matching still gives
    // t1→prd (PM) and t2→style-guide (designer)
    const plan: DispatchPlanItem[] = [
      { id: "t3", agentId: "ag_builder", task: "build app", dependsOn: ["t2", "t1"], expectedOutputs: [], inputs: [], acceptanceCriteria: [] },
    ];
    const result = applyRoleContracts(plan, agents);
    expect(result.plan[0].inputs!.some((i) => i.fromTaskId === "t1" && i.outputId === "prd")).toBe(true);
    expect(result.plan[0].inputs!.some((i) => i.fromTaskId === "t2" && i.outputId === "style-guide")).toBe(true);
  });

  it("does not create spurious input pairings", () => {
    const plan: DispatchPlanItem[] = [
      { id: "t3", agentId: "ag_builder", task: "build app", dependsOn: ["t1", "t2"], expectedOutputs: [], inputs: [], acceptanceCriteria: [] },
    ];
    const result = applyRoleContracts(plan, agents);
    expect(result.plan[0].inputs!.some((i) => i.fromTaskId === "t1" && i.outputId === "style-guide")).toBe(false);
    expect(result.plan[0].inputs!.some((i) => i.fromTaskId === "t2" && i.outputId === "prd")).toBe(false);
  });

  it("does not overwrite existing outputs", () => {
    const plan: DispatchPlanItem[] = [
      { id: "t1", agentId: "ag_pm", task: "write PRD", dependsOn: [], expectedOutputs: [{ id: "custom_prd", type: "document" as const }], inputs: [], acceptanceCriteria: [] },
    ];
    const result = applyRoleContracts(plan, agents);
    expect(result.plan[0].expectedOutputs!.some((o) => o.id === "custom_prd")).toBe(true);
  });

  it("returns not enriched for unknown agents", () => {
    const plan: DispatchPlanItem[] = [
      { id: "tx", agentId: "ag_unknown", task: "do stuff", dependsOn: [], expectedOutputs: [], inputs: [], acceptanceCriteria: [] },
    ];
    const { enriched } = applyRoleContracts(plan, []);
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
