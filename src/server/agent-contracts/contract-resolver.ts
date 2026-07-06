// ---------------------------------------------------------------------------
// P5: Contract Resolver — auto-fill plan tasks with standard role contracts
// ---------------------------------------------------------------------------

import { getRoleContract, detectAgentRole, type AgentRole, type RoleOutputContract } from "@/server/agent-contracts/role-contracts";
import type { DispatchPlanItem } from "@/shared/types";

export interface ContractResolveResult {
  /** The resolved contract (may be null if no role detected) */
  contract: RoleOutputContract | null;
  /** Tasks that were modified with auto-filled fields */
  enriched: boolean;
}

/** Which role produces which standard output key */
const ROLE_OUTPUT_MAP: Record<string, AgentRole> = {
  prd: "pm",
  "style-guide": "ui",
  web_app: "frontend",
  review_report: "reviewer",
};

/**
 * Auto-fill a plan task with its role contract.
 * If the task already has the fields set, the contract augments but doesn't overwrite.
 */
function enrichTask(
  task: DispatchPlanItem,
  contract: RoleOutputContract,
  allPlanTasks: DispatchPlanItem[],
  agents: Array<{ id: string; name: string; capabilities: string[] }>,
  agentName?: string
): DispatchPlanItem {
  const enriched = { ...task };
  const agentMap = new Map(agents.map((a) => [a.id, a]));
  // Build taskId → agentId FROM THE PLAN (not from agents list directly)
  const taskAgentIdMap = new Map(allPlanTasks.map((t) => [t.id, t.agentId]));

  // expectedOutputs: only fill if task doesn't already declare this outputKey
  const existingKeys = new Set((enriched.expectedOutputs ?? []).map((o) => o.id));
  if (!existingKeys.has(contract.outputKey)) {
    enriched.expectedOutputs = [
      ...(enriched.expectedOutputs ?? []),
      {
        id: contract.outputKey,
        type: contract.type,
        required: contract.required,
        description: `${agentName ?? contract.role} 标准输出 — ${contract.contentRequirements[0] ?? ""}`,
      },
    ];
  }

  // inputs: resolve dep taskId → task.agentId → agent → detected role → contract → outputKey.
  if (contract.requiredInputs.length > 0 && enriched.dependsOn && enriched.dependsOn.length > 0) {
    const existingInputs = new Set((enriched.inputs ?? []).map((i) => `${i.fromTaskId}.${i.outputId}`));
    const depOutputs = new Map<string, string>(); // outputKey → depId

    for (const depId of enriched.dependsOn) {
      // Step 1: depId is a task ID (t1, t2) → get its agentId from the plan
      const depAgentId = taskAgentIdMap.get(depId);
      if (!depAgentId) continue;
      // Step 2: look up the agent by agentId
      const depAgent = agentMap.get(depAgentId);
      if (!depAgent) continue;
      // Step 3: detect role from agent capabilities
      const depRole = detectAgentRole(depAgent.capabilities, depAgent.name);
      if (!depRole) continue;
      // Step 4: get the contract for that role → outputKey
      const depContract = getRoleContract(depRole);
      if (depContract && !depOutputs.has(depContract.outputKey)) {
        depOutputs.set(depContract.outputKey, depId);
      }
    }
    const unmatchedDeps = enriched.dependsOn.filter((d) => !Array.from(depOutputs.values()).includes(d));
    let fallbackIdx = 0;

    for (const requiredOutputKey of contract.requiredInputs) {
      let matchedDepId = depOutputs.get(requiredOutputKey);
      if (!matchedDepId && fallbackIdx < unmatchedDeps.length) {
        matchedDepId = unmatchedDeps[fallbackIdx++];
      }
      if (!matchedDepId) continue;

      const inputKey = `${matchedDepId}.${requiredOutputKey}`;
      if (!existingInputs.has(inputKey)) {
        enriched.inputs = [
          ...(enriched.inputs ?? []),
          { fromTaskId: matchedDepId, outputId: requiredOutputKey, required: true, description: `Standard input from ${matchedDepId} — ${requiredOutputKey}` },
        ];
        existingInputs.add(inputKey);
      }
    }
  }

  // acceptanceCriteria: serialize structured contract criteria as JSON strings
  // so the verification engine can deserialize them back to AcceptanceCriterionSpec
  // with real validators (artifact_exists, command_exit, deployment_created, etc.).
  // Fallback description-only strings become optional reviewer_verdict.
  const existingCriteria = new Set((enriched.acceptanceCriteria ?? []).map((c) =>
    typeof c === "string" ? tryExtractCriterionId(c) : (c as { id: string }).id
  ));
  for (const crit of contract.acceptanceCriteria) {
    if (!existingCriteria.has(crit.description.replace(/[^a-zA-Z0-9]/g, "-").toLowerCase())) {
      enriched.acceptanceCriteria = [
        ...(enriched.acceptanceCriteria ?? []),
        JSON.stringify({ id: `contract-${crit.description.replace(/[^a-zA-Z0-9]/g, "-").toLowerCase().slice(0, 30)}`, description: crit.description, required: crit.required, validator: crit.validator }),
      ];
    }
  }

function tryExtractCriterionId(c: string): string {
  try { const p = JSON.parse(c); return p.id ?? c; } catch { return c; }
}

  return enriched;
}

/**
 * Resolve and apply role contracts to all tasks in a plan.
 * Tasks that match a known role get their inputs, expectedOutputs, and
 * acceptanceCriteria auto-filled from the standard contract.
 *
 * Existing fields are NOT overwritten — the contract only fills gaps.
 */
export function applyRoleContracts(
  plan: DispatchPlanItem[],
  agents: Array<{ id: string; name: string; capabilities: string[] }>
): { plan: DispatchPlanItem[]; enriched: boolean } {
  let anyEnriched = false;
  const agentMap = new Map(agents.map((a) => [a.id, a]));

  const enrichedPlan = plan.map((task) => {
    const agent = agentMap.get(task.agentId);
    if (!agent) return task;

    const role = detectAgentRole(agent.capabilities, agent.name);
    if (!role) return task;

    const contract = getRoleContract(role);
    if (!contract) return task;

    const enriched = enrichTask(task, contract, plan, agents, agent.name);
    if (enriched !== task) anyEnriched = true;
    return enriched;
  });

  return { plan: enrichedPlan, enriched: anyEnriched };
}

/**
 * Generate contract-based prompt guidance for the Conductor.
 * Tells the LLM about standard output keys so it generates consistent plans.
 */
export function buildContractGuidance(agents: Array<{ id: string; capabilities: string[]; name: string }>): string {
  const rolesWithContracts: Array<{ agentId: string; agentName: string; contract: RoleOutputContract }> = [];

  for (const agent of agents) {
    const role = detectAgentRole(agent.capabilities, agent.name);
    if (role) {
      const contract = getRoleContract(role);
      if (contract) {
        rolesWithContracts.push({ agentId: agent.id, agentName: agent.name, contract });
      }
    }
  }

  if (rolesWithContracts.length === 0) return "";

  const lines = rolesWithContracts.map((r) =>
    `- **${r.agentId}** (${r.agentName}, role: ${r.contract.role}): standard output "${r.contract.outputKey}" (${r.contract.type}), requires inputs [${r.contract.requiredInputs.join(", ") || "none"}], content: ${r.contract.contentRequirements.slice(0, 3).join("; ")}...`
  );

  return [
    "## 标准角色输出协议",
    "以下 Agent 有预定义的标准输出。请使用指定的 outputKey，不要自由命名：",
    ...lines,
    "",
    "任务之间的 inputs 必须使用上游任务的 outputKey。例如：前端任务应声明 inputs: [{ fromTaskId: \"t1\", outputId: \"prd\" }, { fromTaskId: \"t2\", outputId: \"style-guide\" }]",
  ].join("\n");
}
