import type { DispatchPlanItem } from "@/shared/types";

// ---------------------------------------------------------------------------
// 8.1 parseDispatchPlanToolArgs — strict LLM output validation
// ---------------------------------------------------------------------------

export function parseDispatchPlanToolArgs(args: unknown): DispatchPlanItem[] {
  if (!isRecord(args) || !Array.isArray(args.tasks)) {
    throw new Error("Invalid dispatch plan: plan_tasks args must include a tasks array");
  }

  return (args.tasks as Array<Record<string, unknown>>).map((raw, index) => {
    const id = readNonEmptyString(raw.id, `task at index ${index} id`);
    const agentId = readNonEmptyString(raw.agentId, `task "${id}" agentId`);
    const task = readNonEmptyString(raw.task, `task "${id}" instruction`);

    const dependsOn = Array.isArray(raw.dependsOn)
      ? raw.dependsOn.map((d) => String(d))
      : [];

    const expectedOutputs = Array.isArray(raw.expectedOutputs)
      ? raw.expectedOutputs.map((o) => {
          const output = o as Record<string, unknown>;
          return {
            id: readNonEmptyString(output.id, `task "${id}" expectedOutput id`),
            type: readArtifactOutputType(output.type, `task "${id}" expectedOutput type`),
            required: typeof output.required === "boolean" ? output.required : undefined,
            description: output.description as string | undefined
          };
        })
      : undefined;

    const inputs = Array.isArray(raw.inputs)
      ? raw.inputs.map((i) => ({
          fromTaskId: readNonEmptyString((i as Record<string, unknown>).fromTaskId, `task "${id}" input fromTaskId`),
          outputId: readNonEmptyString((i as Record<string, unknown>).outputId, `task "${id}" input outputId`),
          required: typeof (i as Record<string, unknown>).required === "boolean"
            ? (i as Record<string, unknown>).required as boolean
            : undefined,
          description: (i as Record<string, unknown>).description as string | undefined
        }))
      : undefined;

    const acceptanceCriteria = Array.isArray(raw.acceptanceCriteria)
      ? raw.acceptanceCriteria.map((c) => String(c))
      : undefined;

    const maxAttempts = typeof raw.maxAttempts === "number" ? raw.maxAttempts : undefined;

    return { id, agentId, task, dependsOn, expectedOutputs, inputs, acceptanceCriteria, maxAttempts };
  });
}

// ---------------------------------------------------------------------------
// 8.2 compileAndValidateDispatchPlan — unified entry point for all 3 layers
// ---------------------------------------------------------------------------

/**
 * Compile + validate a dispatch plan in one call.
 * Returns the compiled plan on success, or an error string on failure.
 *
 * Called at:
 *   Layer 2 — immediately after plan_tasks capture (executeConductor)
 *   Layer 3 — approval gate, re-validated before execution
 */
export function compileAndValidateDispatchPlan(
  rawTasks: Array<{ id: string; agentId: string; task?: string; prompt?: string; title?: string; dependsOn?: string[]; inputs?: unknown[]; expectedOutputs?: unknown[]; acceptanceCriteria?: string[]; maxAttempts?: number; targetPaths?: string[]; requiredCommands?: unknown[]; requiredEvidence?: string[] }>,
  availableAgentIds: string[],
  conductorAgentId: string,
  resolvedExternalTaskIds: string[] = []
): DispatchPlanItem[] | string {
  // Convert to DispatchPlanItem format
  const items: DispatchPlanItem[] = rawTasks.map((t) => ({
    id: t.id,
    agentId: t.agentId,
    task: t.task ?? t.prompt ?? "",
    dependsOn: t.dependsOn ?? [],
    title: t.title,
    prompt: t.prompt,
    expectedOutputs: t.expectedOutputs as DispatchPlanItem["expectedOutputs"],
    inputs: t.inputs as DispatchPlanItem["inputs"],
    acceptanceCriteria: t.acceptanceCriteria,
    maxAttempts: t.maxAttempts,
    targetPaths: t.targetPaths,
    requiredCommands: t.requiredCommands as DispatchPlanItem["requiredCommands"],
    requiredEvidence: t.requiredEvidence
  }));

  // Compile: auto-add dependencies, resolve inputs
  const compiled = compileDispatchPlan(items);

  // Validate: agentId existence, no self-dispatch, no cycles, etc.
  const error = validateDispatchPlan(
    compiled,
    availableAgentIds,
    conductorAgentId,
    resolvedExternalTaskIds
  );
  if (error) return error;

  return compiled;
}

// ---------------------------------------------------------------------------
// 8.3 compileDispatchPlan — auto-add dependencies from text heuristics
// ---------------------------------------------------------------------------

export function compileDispatchPlan(plan: DispatchPlanItem[]): DispatchPlanItem[] {
  return plan.map((item, index) => {
    // Keep explicit dependsOn
    const deps = new Set(item.dependsOn);

    // Infer deps from "t1 产物", "基于 PRD", "读取 UI 设计" etc.
    const text = item.task.toLowerCase();
    for (let j = 0; j < index; j++) {
      const prev = plan[j];
      // If current task mentions previous task's id, add dependency
      if (text.includes(prev.id.toLowerCase())) {
        deps.add(prev.id);
      }
      // If current task is review/verify/test type, depend on all previous production tasks
      if (isReviewTask(item) && !isReviewTask(prev)) {
        deps.add(prev.id);
      }
    }

    // Resolve inputs → dependsOn
    if (item.inputs) {
      for (const input of item.inputs) {
        if (!deps.has(input.fromTaskId)) {
          deps.add(input.fromTaskId);
        }
      }
    }

    return { ...item, dependsOn: Array.from(deps) };
  });
}

// ---------------------------------------------------------------------------
// 8.3 validateDispatchPlan — comprehensive checks
// ---------------------------------------------------------------------------

export function validateDispatchPlan(
  plan: DispatchPlanItem[],
  availableAgentIds: string[],
  conductorAgentId: string,
  resolvedExternalTaskIds: string[] = []
): string | null {
  if (plan.length === 0) return "Plan must contain at least one task.";

  const availableSet = new Set(availableAgentIds);
  const taskIds = new Set(plan.map((t) => t.id));
  const knownDependencyIds = new Set([...taskIds, ...resolvedExternalTaskIds]);

  // Duplicate IDs
  if (taskIds.size !== plan.length) return "Duplicate task IDs found.";

  for (const task of plan) {
    // Can't assign to conductor self
    if (task.agentId === conductorAgentId) {
      return `Task "${task.id}" cannot be assigned to the Conductor itself (would cause recursion).`;
    }

    // Agent must be available
    if (!availableSet.has(task.agentId)) {
      return `Task "${task.id}" uses unknown agent "${task.agentId}".`;
    }

    // dependsOn constraints
    const seenDeps = new Set<string>();
    for (const dep of task.dependsOn) {
      if (dep === task.id) return `Task "${task.id}" depends on itself.`;
      if (!knownDependencyIds.has(dep)) return `Task "${task.id}" depends on unknown task "${dep}".`;
      if (seenDeps.has(dep)) return `Task "${task.id}" has duplicate dependency "${dep}".`;
      seenDeps.add(dep);
    }

    // Validate expectedOutputs IDs uniqueness
    if (task.expectedOutputs) {
      const outputIds = new Set(task.expectedOutputs.map((o) => o.id));
      if (outputIds.size !== task.expectedOutputs.length) {
        return `Task "${task.id}" has duplicate expectedOutput ids.`;
      }
    }

    // Validate inputs reference existing tasks
    if (task.inputs) {
      for (const input of task.inputs) {
        if (!knownDependencyIds.has(input.fromTaskId)) {
          return `Task "${task.id}" input references unknown task "${input.fromTaskId}".`;
        }
        const upstream = plan.find((t) => t.id === input.fromTaskId);
        if (upstream?.expectedOutputs && !upstream.expectedOutputs.some((o) => o.id === input.outputId)) {
          return `Task "${task.id}" input references unknown output "${input.outputId}" from task "${input.fromTaskId}".`;
        }
      }
    }
  }

  // Cycle detection via DFS
  if (detectCycle(plan)) return "Plan contains a circular dependency.";

  return null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readNonEmptyString(value: unknown, context: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Invalid dispatch plan: ${context} must be a non-empty string. Got: ${JSON.stringify(value)}`);
  }
  return value.trim();
}

function readArtifactOutputType(
  value: unknown,
  context: string
): "web_app" | "document" | "image" | "ppt" {
  if (value === "web_app" || value === "document" || value === "image" || value === "ppt") {
    return value;
  }
  throw new Error(`Invalid dispatch plan: ${context} is invalid. Got: ${JSON.stringify(value)}`);
}

function isReviewTask(task: DispatchPlanItem): boolean {
  const text = task.task.toLowerCase();
  return text.includes("审查") || text.includes("review") || text.includes("验证") || text.includes("测试");
}

function detectCycle(plan: DispatchPlanItem[]): boolean {
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const taskMap = new Map(plan.map((t) => [t.id, t]));

  function dfs(id: string): boolean {
    if (visiting.has(id)) return true;
    if (visited.has(id)) return false;
    visiting.add(id);
    const task = taskMap.get(id);
    if (task) {
      for (const dep of task.dependsOn) {
        if (dfs(dep)) return true;
      }
    }
    visiting.delete(id);
    visited.add(id);
    return false;
  }

  return plan.some((t) => dfs(t.id));
}
