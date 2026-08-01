// ---------------------------------------------------------------------------
// P5: Role Contracts tests
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import {
  getRoleContract, detectAgentRole, getAllRoleContracts,
  PM_CONTRACT, UI_CONTRACT, FRONTEND_CONTRACT, REVIEWER_CONTRACT,
} from "@/server/agent-contracts/role-contracts";
import {
  applyRoleContracts,
  buildContractGuidance,
  resolveTaskIntent,
} from "@/server/agent-contracts/contract-resolver";
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
    expect(REVIEWER_CONTRACT.outputKey).toBe("review_report");
    expect(REVIEWER_CONTRACT.expectedTools).toContain("write_artifact");
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

  it("repairs omitted standard DAG edges and input bindings", () => {
    const incompletePlan: DispatchPlanItem[] = [
      {
        id: "t1",
        agentId: "ag_pm",
        task: "write PRD",
        dependsOn: [],
        expectedOutputs: [{ id: "prd", type: "document", required: true }],
        inputs: [],
        acceptanceCriteria: [],
      },
      {
        id: "t2",
        agentId: "ag_designer",
        task: "design UI",
        dependsOn: [],
        expectedOutputs: [{ id: "style-guide", type: "document", required: true }],
        inputs: [],
        acceptanceCriteria: [],
      },
      {
        id: "t3",
        agentId: "ag_builder",
        task: "build app",
        dependsOn: [],
        expectedOutputs: [{ id: "web_app", type: "web_app", required: true }],
        inputs: [],
        acceptanceCriteria: [],
      },
    ];

    const [, ui, frontend] = applyRoleContracts(incompletePlan, agents).plan;
    expect(ui.dependsOn).toContain("t1");
    expect(ui.inputs).toContainEqual(expect.objectContaining({
      fromTaskId: "t1",
      outputId: "prd",
      required: true,
    }));
    expect(frontend.dependsOn).toEqual(expect.arrayContaining(["t1", "t2"]));
    expect(frontend.inputs).toEqual(expect.arrayContaining([
      expect.objectContaining({ fromTaskId: "t1", outputId: "prd", required: true }),
      expect.objectContaining({ fromTaskId: "t2", outputId: "style-guide", required: true }),
    ]));
  });

  it("preserves an explicit custom output contract without appending the role default", () => {
    const customPlan: DispatchPlanItem[] = [
      { id: "t1", agentId: "ag_pm", task: "write PRD", dependsOn: [], expectedOutputs: [{ id: "custom_prd", type: "document" as const }], inputs: [], acceptanceCriteria: [] },
    ];
    const result = applyRoleContracts(customPlan, agents);
    expect(result.plan[0].expectedOutputs).toEqual([
      expect.objectContaining({ id: "custom_prd", type: "document" }),
    ]);
    expect(result.plan[0].contractProfile).toBe("minimal");
    expect(result.plan[0].contractSelectionReason).toContain("custom delivery contract");
    expect(result.plan[0].acceptanceCriteria).toEqual([]);
  });

  it("does not inject standard handoff inputs into a custom delivery chain", () => {
    const plan: DispatchPlanItem[] = [
      {
        id: "t1",
        agentId: "ag_pm",
        task: "Define a regex matching contract",
        dependsOn: [],
        inputs: [],
        expectedOutputs: [{ id: "matching-contract", type: "document", required: true }],
        acceptanceCriteria: ["Contract is complete"],
      },
      {
        id: "t2",
        agentId: "ag_builder",
        task: "Implement the regex from the matching contract",
        dependsOn: ["t1"],
        inputs: [{ fromTaskId: "t1", outputId: "matching-contract", required: true }],
        expectedOutputs: [{ id: "regex-evidence", type: "document", required: true }],
        acceptanceCriteria: ["Public tests pass"],
      },
    ];

    const [pm, frontend] = applyRoleContracts(plan, agents).plan;
    expect(pm.expectedOutputs?.map((output) => output.id)).toEqual(["matching-contract"]);
    expect(frontend.expectedOutputs?.map((output) => output.id)).toEqual(["regex-evidence"]);
    expect(frontend.inputs).toEqual([
      expect.objectContaining({ fromTaskId: "t1", outputId: "matching-contract" }),
    ]);
    expect(frontend.inputs?.some((input) => input.outputId === "prd")).toBe(false);
    expect(frontend.inputs?.some((input) => input.outputId === "style-guide")).toBe(false);
  });

  it("returns not enriched for unknown agents", () => {
    const unknownPlan: DispatchPlanItem[] = [
      { id: "tx", agentId: "ag_unknown", task: "do stuff", dependsOn: [], expectedOutputs: [], inputs: [], acceptanceCriteria: [] },
    ];
    const { enriched } = applyRoleContracts(unknownPlan, []);
    expect(enriched).toBe(false);
  });

  it("uses a minimal contract for dependency approval probes", () => {
    const plan: DispatchPlanItem[] = [{
      id: "t1",
      agentId: "ag_builder",
      task: "Install one dependency after user approval",
      title: "Dependency install approval probe",
      prompt: "Run npm install only after approval and report the command result.",
      dependsOn: [],
      expectedOutputs: [],
      acceptanceCriteria: [],
    }];

    const result = applyRoleContracts(plan, agents).plan[0];
    expect(result.taskIntent).toBe("approval_probe");
    expect(result.contractProfile).toBe("minimal");
    expect(result.expectedOutputs).toEqual([]);
    expect(result.acceptanceCriteria).toEqual([]);
  });

  it("does not treat a negated artifact instruction as delivery", () => {
    const plan: DispatchPlanItem[] = [{
      id: "t1",
      agentId: "ag_builder",
      task: "Run npm install after approval. 不需要创建任何产物，只汇报安装结果。",
      taskIntent: "approval_probe",
      dependsOn: [],
      expectedOutputs: [],
      acceptanceCriteria: [],
    }];

    const result = applyRoleContracts(plan, agents).plan[0];
    expect(result.taskIntent).toBe("approval_probe");
    expect(result.contractProfile).toBe("minimal");
    expect(result.expectedOutputs).toEqual([]);
  });

  it("keeps a repair delivery contract when dependency installation is only a sub-step", () => {
    const plan: DispatchPlanItem[] = [{
      id: "t1",
      agentId: "ag_builder",
      title: "Fix and build the React Todo App",
      task: "Fix the source, run npm install, retry npm run build after the injected failure, then deploy dist.",
      dependsOn: [],
      expectedOutputs: [],
      acceptanceCriteria: [],
      taskIntent: "delivery",
    }];

    const result = applyRoleContracts(plan, agents).plan[0];
    expect(result.taskIntent).toBe("delivery");
    expect(result.contractProfile).toBe("standard");
    expect(result.contractSelectionReason).toContain("implementation or delivery");
    expect(result.contractSelectionVersion).toBe("role-contract-intent-v2");
    expect(result.expectedOutputs).toContainEqual(expect.objectContaining({
      id: "web_app",
      type: "web_app",
      required: true,
    }));
  });

  it("does not invent a PRD input from a PM diagnosis dependency", () => {
    const plan: DispatchPlanItem[] = [
      {
        id: "t1",
        agentId: "ag_pm",
        title: "诊断破损的 React 应用",
        task: "读取源码并通过 write_artifact 输出 diagnosis 诊断报告。",
        taskIntent: "delivery",
        dependsOn: [],
        expectedOutputs: [{ id: "diagnosis", type: "document", required: true }],
        acceptanceCriteria: [],
      },
      {
        id: "t2",
        agentId: "ag_builder",
        title: "修复并部署应用",
        task: "读取 diagnosis，修复源码、构建并部署。",
        taskIntent: "delivery",
        dependsOn: ["t1"],
        inputs: [{ fromTaskId: "t1", outputId: "diagnosis", required: true }],
        expectedOutputs: [{ id: "web_app", type: "web_app", required: true }],
        acceptanceCriteria: [],
      },
    ];

    const [diagnosis, frontend] = applyRoleContracts(plan, agents).plan;
    expect(diagnosis.taskIntent).toBe("diagnosis");
    expect(diagnosis.expectedOutputs).toEqual([
      expect.objectContaining({ id: "diagnosis" }),
    ]);
    expect(frontend.inputs).toEqual([
      expect.objectContaining({ fromTaskId: "t1", outputId: "diagnosis" }),
    ]);
  });

  it("uses a minimal contract for controlled false-completion tests", () => {
    const plan: DispatchPlanItem[] = [{
      id: "t1",
      agentId: "ag_builder",
      task: "Run a controlled fake artifact id negative verifier test",
      dependsOn: [],
      expectedOutputs: [],
      acceptanceCriteria: [],
      taskIntent: "negative_verifier_test",
    }];

    const result = applyRoleContracts(plan, agents).plan[0];
    expect(result.taskIntent).toBe("negative_verifier_test");
    expect(result.expectedOutputs).toEqual([]);
  });

  it("removes an accidental standard output from an explicit controlled negative test", () => {
    const plan: DispatchPlanItem[] = [{
      id: "t1",
      agentId: "ag_builder",
      task: "受控负向测试：创建文件后验证 Bash 源码修改会被平台阻断。",
      dependsOn: [],
      expectedOutputs: [{ id: "web_app", type: "web_app", required: true }],
      acceptanceCriteria: [JSON.stringify({
        id: "accidental-deploy",
        required: true,
        validator: { type: "deployment_created", outputKey: "web_app" },
      })],
      taskIntent: "negative_verifier_test",
    }];

    const result = applyRoleContracts(plan, agents).plan[0];
    expect(result.taskIntent).toBe("negative_verifier_test");
    expect(result.contractProfile).toBe("minimal");
    expect(result.expectedOutputs).toEqual([]);
    expect(result.acceptanceCriteria).toEqual([]);
    expect(result.contractSelectionVersion).toBe("role-contract-intent-v2");
  });

  it("does not allow a minimal declared intent to bypass an explicit standard output", () => {
    const task: DispatchPlanItem = {
      id: "t1",
      agentId: "ag_builder",
      task: "Build the application",
      dependsOn: [],
      expectedOutputs: [{ id: "web_app", type: "web_app", required: true }],
      taskIntent: "verification",
    };

    expect(resolveTaskIntent(task, FRONTEND_CONTRACT)).toBe("delivery");
    const result = applyRoleContracts([task], agents).plan[0];
    expect(result.contractProfile).toBe("standard");
    expect(result.acceptanceCriteria?.length).toBeGreaterThan(0);
  });

  it("honors explicit verification intent when no output contract requires delivery", () => {
    const task: DispatchPlanItem = {
      id: "t1",
      agentId: "ag_builder",
      task: "检查空工作区并汇报状态，不要创建、构建或部署应用。",
      dependsOn: [],
      taskIntent: "verification",
    };

    expect(resolveTaskIntent(task, FRONTEND_CONTRACT)).toBe("verification");
    const result = applyRoleContracts([task], agents).plan[0];
    expect(result.contractProfile).toBe("minimal");
    expect(result.expectedOutputs).toBeUndefined();
  });
});

describe("buildContractGuidance", () => {
  it("generates guidance text for known roles", () => {
    const agents = [{ id: "ag_pm", name: "PM", capabilities: ["pm"] }];
    const guidance = buildContractGuidance(agents);
    expect(guidance).toContain("标准角色输出协议");
    expect(guidance).toContain("prd");
    expect(guidance).toContain("ag_pm");
    expect(guidance).toContain("taskIntent");
  });

  it("returns empty for no matching roles", () => {
    expect(buildContractGuidance([])).toBe("");
  });
});
