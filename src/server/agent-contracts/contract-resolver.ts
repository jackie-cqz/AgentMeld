// ---------------------------------------------------------------------------
// P5: Contract Resolver — auto-fill plan tasks with standard role contracts
// ---------------------------------------------------------------------------

import { getRoleContract, detectAgentRole, type AgentRole, type RoleOutputContract } from "@/server/agent-contracts/role-contracts";
import type { DispatchPlanItem, DispatchTaskIntent } from "@/shared/types";

export interface ContractResolveResult {
  /** The resolved contract (may be null if no role detected) */
  contract: RoleOutputContract | null;
  /** Tasks that were modified with auto-filled fields */
  enriched: boolean;
}

export const ROLE_CONTRACT_SELECTION_VERSION = "role-contract-intent-v2";

export interface TaskIntentDecision {
  taskIntent: DispatchTaskIntent;
  reason: string;
  version: string;
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
  const decision = resolveTaskIntentDecision(task, contract);
  const taskIntent = decision.taskIntent;
  const enriched: DispatchPlanItem = {
    ...task,
    taskIntent,
    contractProfile: taskIntent === "delivery" ? "standard" : "minimal",
    contractSelectionReason: decision.reason,
    contractSelectionVersion: decision.version,
  };
  if (taskIntent !== "delivery") {
    if (taskIntent === "negative_verifier_test") {
      if (task.expectedOutputs) {
        enriched.expectedOutputs = task.expectedOutputs.filter(
          (output) => output.id !== contract.outputKey
        );
      }
      if (task.acceptanceCriteria) {
        enriched.acceptanceCriteria = task.acceptanceCriteria.filter((criterion) => {
          const serialized = typeof criterion === "string" ? criterion : JSON.stringify(criterion);
          return !criteriaReferencesOutput(serialized, contract.outputKey)
            && !/"type"\s*:\s*"deployment_created"/i.test(serialized);
        });
      }
    }
    return enriched;
  }
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
      const depTask = allPlanTasks.find((candidate) => candidate.id === depId);
      if (!depTask) continue;
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
      if (!depContract) continue;
      // A role label alone does not prove this task produced the role's
      // standard deliverable. Diagnosis/verification tasks must not be
      // treated as PRD/style-guide/web-app producers.
      if (resolveTaskIntent(depTask, depContract) !== "delivery") continue;
      if (!depOutputs.has(depContract.outputKey)) {
        depOutputs.set(depContract.outputKey, depId);
      }
    }

    for (const requiredOutputKey of contract.requiredInputs) {
      const matchedDepId = depOutputs.get(requiredOutputKey);
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
    const criterionId = buildContractCriterionId(crit);
    if (!existingCriteria.has(criterionId)) {
      enriched.acceptanceCriteria = [
        ...(enriched.acceptanceCriteria ?? []),
        JSON.stringify({ id: criterionId, description: crit.description, required: crit.required, validator: crit.validator }),
      ];
      existingCriteria.add(criterionId);
    }
  }

  return enriched;
}

function tryExtractCriterionId(c: string): string {
  try { const p = JSON.parse(c); return p.id ?? c; } catch { return c; }
}

/**
 * Resolve task intent from machine-verifiable requirements first, then task
 * wording. A model-proposed non-delivery intent cannot override an explicit
 * standard deliverable or an implementation/deployment task.
 */
export function resolveTaskIntent(
  task: DispatchPlanItem,
  contract: RoleOutputContract,
): DispatchTaskIntent {
  return resolveTaskIntentDecision(task, contract).taskIntent;
}

export function resolveTaskIntentDecision(
  task: DispatchPlanItem,
  contract: RoleOutputContract,
): TaskIntentDecision {
  const decide = (taskIntent: DispatchTaskIntent, reason: string): TaskIntentDecision => ({
    taskIntent,
    reason,
    version: ROLE_CONTRACT_SELECTION_VERSION,
  });
  const criteria = (task.acceptanceCriteria ?? []).join("\n");
  const text = [
    task.title ?? "",
    task.task,
    task.prompt ?? "",
    criteria,
  ].join("\n");
  const controlledNegativePattern =
    /negative[_ -]?verifier(?:[_ -]?test)?|false completion|fake artifact|fake deployment|guessed_artifact_id|tool_claim_without_evidence|伪造|虚假完成|负向(?:验证|测试)/i;
  if (task.taskIntent === "negative_verifier_test" && controlledNegativePattern.test(text)) {
    return decide("negative_verifier_test", "explicit controlled negative verifier scenario overrides an accidental standard output");
  }

  const expectedOutputs = task.expectedOutputs ?? [];
  if (expectedOutputs.some((output) => output.id === contract.outputKey)) {
    return decide("delivery", `required output ${contract.outputKey} is explicitly declared`);
  }

  if (
    criteriaReferencesOutput(criteria, contract.outputKey)
    || /"type"\s*:\s*"deployment_created"/i.test(criteria)
  ) {
    return decide("delivery", `acceptance criteria require ${contract.outputKey} or a deployment`);
  }

  const intentAnchor = task.title?.trim() || task.task.slice(0, 160);
  const hasStrongDeliveryAction =
    /\b(implement|fix|create|develop|deploy|deliver|write|design)\b|实现|修复|创建|开发|部署|交付|编写|设计/i.test(text);

  if (
    controlledNegativePattern.test(text)
  ) {
    return decide("negative_verifier_test", "task is a controlled negative verifier scenario");
  }
  if (
    /\bdiagnos(?:e|is|tic)\b|诊断|根因分析|错误分析/i.test(intentAnchor)
  ) {
    return decide("diagnosis", "task title or leading objective is diagnostic");
  }
  if (
    task.taskIntent === "approval_probe"
    && /dependency install|install dependency|approval probe|approval policy|npm install|pnpm install|依赖安装|审批策略|审批测试/i.test(text)
  ) {
    return decide("approval_probe", "explicit approval probe has no required delivery output");
  }
  if (task.taskIntent && task.taskIntent !== "delivery" && !hasStrongDeliveryAction) {
    return decide(task.taskIntent, "model-proposed non-delivery intent is compatible with task actions");
  }
  if (
    /verification only|review only|read-only|只读|仅验证|只检查|不要(?:创建|构建|部署|修改)/i.test(text)
  ) {
    return decide("verification", "task explicitly requests read-only or verification-only work");
  }
  if (
    /\b(build|implement|fix|create|develop|deploy|deliver|write|design)\b|实现|修复|构建|创建|开发|部署|交付|编写|设计/i.test(text)
  ) {
    return decide("delivery", "task contains a strong implementation or delivery action");
  }
  if (
    /dependency install|install dependency|approval probe|approval policy|npm install|pnpm install|依赖安装|审批策略|审批测试/i.test(text)
  ) {
    return decide("approval_probe", "task is limited to dependency-install or approval-policy behavior");
  }
  if (
    /verify\b|validate\b|audit\b|inspect\b|验证|校验|审计|检查|汇报状态/i.test(text)
  ) {
    return decide("verification", "task primarily requests validation, audit, or inspection");
  }

  return decide(task.taskIntent ?? "delivery", task.taskIntent
    ? "model-proposed intent is compatible with the deterministic policy"
    : "no narrower intent matched; use the role delivery contract");
}

function criteriaReferencesOutput(criteria: string, outputKey: string): boolean {
  if (!criteria || !outputKey) return false;
  try {
    return criteria
      .split("\n")
      .some((criterion) => {
        const parsed = JSON.parse(criterion) as {
          validator?: { outputKey?: unknown };
        };
        return parsed.validator?.outputKey === outputKey;
      });
  } catch {
    return criteria.includes(outputKey);
  }
}

function buildContractCriterionId(crit: RoleOutputContract["acceptanceCriteria"][number]): string {
  const validator = crit.validator;
  switch (validator.type) {
    case "artifact_exists":
      return compactCriterionId(["contract", "artifact", validator.outputKey, validator.artifactType]);
    case "deployment_created":
      return compactCriterionId(["contract", "deployment", validator.outputKey]);
    case "command_exit":
      return compactCriterionId(["contract", "command", validator.command, String(validator.expectedExitCode)]);
    case "file_exists":
      return compactCriterionId(["contract", "file", validator.path]);
    case "file_changed":
      return compactCriterionId(["contract", "file-changed", validator.path]);
    case "user_confirmation":
      return "contract-user-confirmation";
    case "reviewer_verdict":
      return compactCriterionId(["contract", "reviewer", validator.reviewerAgentId]);
    default:
      return compactCriterionId(["contract", crit.description]);
  }
}

function compactCriterionId(parts: Array<string | undefined>): string {
  const body = parts
    .filter(Boolean)
    .join("-")
    .replace(/[^a-zA-Z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase()
    .slice(0, 80);
  return body || "contract";
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

  const handoffPlan = enrichedPlan.map((task, taskIndex) => {
    const agent = agentMap.get(task.agentId);
    const role = agent ? detectAgentRole(agent.capabilities, agent.name) : null;
    const contract = role ? getRoleContract(role) : null;
    if (!contract || task.taskIntent !== "delivery" || contract.requiredInputs.length === 0) {
      return task;
    }

    const dependsOn = [...(task.dependsOn ?? [])];
    const inputs = [...(task.inputs ?? [])];
    let changed = false;

    for (const requiredOutputKey of contract.requiredInputs) {
      if (inputs.some((input) => input.outputId === requiredOutputKey)) continue;

      // Standard role handoffs are deterministic. If the model omitted the
      // DAG edge, bind the nearest preceding delivery task that explicitly
      // declares the required output. Restricting the search to preceding
      // tasks prevents the resolver from introducing cycles.
      const producer = enrichedPlan
        .slice(0, taskIndex)
        .reverse()
        .find((candidate) =>
          candidate.taskIntent === "delivery"
          && (candidate.expectedOutputs ?? []).some((output) => output.id === requiredOutputKey)
        );
      if (!producer) continue;

      if (!dependsOn.includes(producer.id)) {
        dependsOn.push(producer.id);
      }
      inputs.push({
        fromTaskId: producer.id,
        outputId: requiredOutputKey,
        required: true,
        description: `Standard input from ${producer.id} — ${requiredOutputKey}`,
      });
      changed = true;
    }

    if (!changed) return task;
    anyEnriched = true;
    return { ...task, dependsOn, inputs };
  });

  return { plan: handoffPlan, enriched: anyEnriched };
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
    "仅当任务需要该角色的标准交付物时设置 taskIntent=\"delivery\"。依赖审批、故障诊断、纯验证和受控负向 verifier 测试应分别使用 approval_probe、diagnosis、verification、negative_verifier_test；平台会根据 expectedOutputs 和验收条件复核，不能用 taskIntent 绕过 required output。",
    "任务之间的 inputs 必须使用上游任务的 outputKey。例如：前端任务应声明 inputs: [{ fromTaskId: \"t1\", outputId: \"prd\" }, { fromTaskId: \"t2\", outputId: \"style-guide\" }]",
  ].join("\n");
}
