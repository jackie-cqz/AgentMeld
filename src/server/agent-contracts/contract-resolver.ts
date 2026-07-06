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

/**
 * Auto-fill a plan task with its role contract.
 * If the task already has the fields set, the contract augments but doesn't overwrite.
 */
function enrichTask(
  task: DispatchPlanItem,
  contract: RoleOutputContract,
  agentName?: string
): DispatchPlanItem {
  const enriched = { ...task };

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

  // inputs: auto-fill required inputs by positionally pairing each
  // requiredOutputKey with one dependency (first dep → first required input,
  // second dep → second required input, etc.). This avoids creating spurious
  // pairings like t2.prd when t2 is the UI designer.
  if (contract.requiredInputs.length > 0 && enriched.dependsOn && enriched.dependsOn.length > 0) {
    const existingInputs = new Set((enriched.inputs ?? []).map((i) => `${i.fromTaskId}.${i.outputId}`));
    const deps = enriched.dependsOn;
    for (let k = 0; k < contract.requiredInputs.length && k < deps.length; k++) {
      const depId = deps[k];
      const outputKey = contract.requiredInputs[k];
      const inputKey = `${depId}.${outputKey}`;
      if (!existingInputs.has(inputKey)) {
        enriched.inputs = [
          ...(enriched.inputs ?? []),
          { fromTaskId: depId, outputId: outputKey, required: true, description: `Standard input from ${depId} — ${outputKey}` },
        ];
        existingInputs.add(inputKey);
      }
    }
  }

  // acceptanceCriteria: append contract criteria as serialized description strings.
  // DispatchPlanItem.acceptanceCriteria is string[], so we store only the description
  // text (the validator is enforced at verification time by the verification engine).
  const existingCriteria = new Set((enriched.acceptanceCriteria ?? []).map((c) =>
    typeof c === "string" ? c : (c as { description: string }).description
  ));
  for (const crit of contract.acceptanceCriteria) {
    if (!existingCriteria.has(crit.description)) {
      enriched.acceptanceCriteria = [
        ...(enriched.acceptanceCriteria ?? []),
        crit.description,
      ];
    }
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

    const enriched = enrichTask(task, contract, agent.name);
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
