import { z } from "zod";
import { recordTaskReport } from "@/server/dispatch-task-results";
import { getConversation } from "@/server/repositories";
import type { ToolDef } from "@/server/tools/types";

// ---------------------------------------------------------------------------
// plan_tasks
// ---------------------------------------------------------------------------

export const planTasksTool: ToolDef = {
  name: "plan_tasks",
  description:
    "Create a plan of subtasks to delegate to other agents. " +
    "Only available to Conductor agents. Each task specifies an agent, instructions, and dependencies.",
  parameters: {
    type: "object",
    required: ["reasoning", "tasks"],
    properties: {
      reasoning: {
        type: "string",
        description: "Brief explanation of the plan structure (3 sentences max)."
      },
      tasks: {
        type: "array",
        items: {
          type: "object",
          required: ["id", "agentId", "title", "prompt"],
          properties: {
            id: { type: "string", description: "Unique task id, e.g. 't1', 't2'." },
            agentId: { type: "string", description: "Agent ID to assign this task to." },
            title: { type: "string", description: "Short title for the task." },
            prompt: { type: "string", description: "Full instructions for the child agent." },
            dependsOn: {
              type: "array",
              items: { type: "string" },
              description: "Task IDs that must complete before this one starts."
            },
            inputs: {
              type: "array",
              items: {
                type: "object",
                required: ["fromTaskId", "outputId"],
                properties: {
                  fromTaskId: { type: "string" },
                  outputId: { type: "string" },
                  required: { type: "boolean", description: "Default true." },
                  description: { type: "string" }
                }
              }
            },
            expectedOutputs: {
              type: "array",
              items: {
                type: "object",
                required: ["id", "type"],
                properties: {
                  id: { type: "string" },
                  type: { type: "string", enum: ["web_app", "document", "image", "ppt"] },
                  required: { type: "boolean" },
                  description: { type: "string" }
                }
              }
            },
            acceptanceCriteria: {
              type: "array",
              items: { type: "string" },
              description: "Criteria to verify task completion."
            },
            maxAttempts: {
              type: "number",
              description: "Max retry attempts (default 1)."
            },
            targetPaths: {
              type: "array",
              items: { type: "string" },
              description: "Files the assigned agent is expected to create or modify."
            },
            requiredCommands: {
              type: "array",
              items: {
                type: "object",
                required: ["command"],
                properties: {
                  command: { type: "string" },
                  timeoutMs: { type: "number", description: "Optional timeout in ms." }
                }
              },
              description: "Commands the assigned agent should run for validation."
            },
            requiredEvidence: {
              type: "array",
              items: { type: "string" },
              description: "Human-readable items the agent should include in its report_task_result."
            }
          }
        }
      }
    }
  },
  async handler(args, ctx) {
    const parsed = planArgsSchema.safeParse(args);
    if (!parsed.success) {
      return { ok: false, error: `Invalid plan: ${parsed.error.message}` };
    }

    const { reasoning, tasks: rawTasks } = parsed.data;

    // Look up conversation agents and all agents for auto-correction
    let agentMap = new Map<string, string>();
    let availableAgents: Array<{ id: string; name: string; capabilities: string[] }> = [];
    try {
      const { listAgents } = await import("@/server/repositories");
      const allAgents = listAgents();
      const conv = getConversation(ctx.conversationId);
      if (conv) {
        availableAgents = allAgents.filter(
          (agent) => conv.agentIds.includes(agent.id) && !agent.isConductor
        );
        agentMap = buildAgentAliasMap(conv.agentIds, availableAgents);
      }
    } catch { /* proceed without auto-correction */ }

    // Auto-correct task agentIds (exact alias + fuzzy task-based guessing)
    const tasks = rawTasks.map((t) => ({ ...t }));
    const correctedCount = correctAgentIds(tasks, agentMap, availableAgents);

    // Validate corrected plan
    let availableAgentIds: string[] | undefined;
    try {
      const conv = getConversation(ctx.conversationId);
      if (conv) {
        availableAgentIds = availableAgents.map((agent) => agent.id);
      }
    } catch { /* proceed */ }

    const validation = validatePlan(tasks, availableAgentIds);
    if (validation) {
      return { ok: false, error: validation };
    }

    return {
      ok: true,
      value: {
        acknowledged: true,
        taskCount: tasks.length,
        reasoning,
        tasks,
        correctedCount
      }
    };
  }
};

// ---------------------------------------------------------------------------
// report_task_result
// ---------------------------------------------------------------------------

export const reportTaskResultTool: ToolDef = {
  name: "report_task_result",
  description:
    "Report the final result of a dispatched task. Must be called once before the child agent finishes. " +
    "Use minimal arguments: status and summary. Do not hand-write artifact maps; write_artifact outputKey is recorded automatically.",
  parameters: {
    type: "object",
    required: ["status", "summary"],
    properties: {
      status: {
        type: "string",
        enum: ["complete", "failed", "blocked"],
        description: "Task outcome."
      },
      summary: {
        type: "string",
        description: "Concise summary of what was accomplished or why it failed."
      },
      blockers: {
        type: "array",
        items: { type: "string" },
        description: "List of blocking issues (for failed/blocked status)."
      }
    }
  },
  async handler(args, ctx) {
    const parsed = reportSchema.safeParse(args);
    if (!parsed.success) {
      return { ok: false, error: `Invalid report: ${parsed.error.message}` };
    }

    // Record task result for conductor evaluation (when runId is set)
    if (ctx.runId) {
      recordTaskReport(ctx.runId, {
        taskId: "",
        runId: ctx.runId,
        status: parsed.data.status,
        summary: parsed.data.summary,
        acceptanceResults: parsed.data.acceptanceResults ?? [],
        blockers: parsed.data.blockers ?? [],
        artifacts: parsed.data.artifacts ?? {},
        files: parsed.data.files ?? [],
        commands: parsed.data.commands ?? [],
        tests: parsed.data.tests ?? []
      });
    }

    return {
      ok: true,
      value: {
        acknowledged: true,
        status: parsed.data.status,
        summary: parsed.data.summary,
        acceptanceResults: parsed.data.acceptanceResults ?? [],
        blockers: parsed.data.blockers ?? []
      }
    };
  }
};

// ---------------------------------------------------------------------------
// Schemas & validation
// ---------------------------------------------------------------------------

export const planArgsSchema = z.object({
  reasoning: z.string().max(500),
  tasks: z
    .array(
      z.object({
        id: z.string().min(1),
        agentId: z.string().min(1),
        title: z.string().min(1).max(200),
        prompt: z.string().min(1).max(8000),
        dependsOn: z.array(z.string()).optional(),
        inputs: z
          .array(
            z.object({
              fromTaskId: z.string(),
              outputId: z.string(),
              required: z.boolean().optional(),
              description: z.string().optional()
            })
          )
          .optional(),
        expectedOutputs: z
          .array(
            z.object({
              id: z.string(),
              type: z.enum(["web_app", "document", "image", "ppt"]),
              required: z.boolean().optional(),
              description: z.string().optional()
            })
          )
          .optional(),
        acceptanceCriteria: z.array(z.string()).optional(),
        maxAttempts: z.number().min(1).max(5).optional(),
        targetPaths: z.array(z.string()).optional(),
        requiredCommands: z
          .array(
            z.object({
              command: z.string(),
              timeoutMs: z.number().optional()
            })
          )
          .optional(),
        requiredEvidence: z.array(z.string()).optional()
      })
    )
    .min(1)
    .max(20)
});

export const reportSchema = z.object({
  status: z.enum(["complete", "failed", "blocked"]),
  summary: z.string().min(1).max(2000),
  acceptanceResults: z
    .array(z.object({ criterion: z.string(), passed: z.boolean(), evidence: z.string() }))
    .optional(),
  blockers: z.array(z.string()).optional(),
  artifacts: z.record(z.string(), z.string()).optional(),
  files: z
    .array(
      z.object({
        path: z.string(),
        action: z.enum(["created", "modified", "deleted", "read"]).optional(),
        summary: z.string().optional()
      })
    )
    .optional(),
  commands: z
    .array(
      z.object({
        command: z.string(),
        exitCode: z.number(),
        passed: z.boolean().optional(),
        summary: z.string().optional()
      })
    )
    .optional(),
  tests: z
    .array(
      z.object({
        command: z.string(),
        passed: z.boolean(),
        summary: z.string().optional()
      })
    )
    .optional()
});

export interface ParsedTask {
  id: string;
  agentId: string;
  title: string;
  prompt: string;
  dependsOn: string[];
  inputs: Array<{
    fromTaskId: string;
    outputId: string;
    required: boolean;
    description?: string;
  }>;
  expectedOutputs: Array<{
    id: string;
    type: "web_app" | "document" | "image" | "ppt";
    required: boolean;
    description?: string;
  }>;
  acceptanceCriteria: string[];
  maxAttempts: number;
  /** Paths the assigned agent is expected to create/modify (for evidence contract) */
  targetPaths?: string[];
  /** Commands the assigned agent is expected to run (for evidence contract) */
  requiredCommands?: Array<{ command: string; timeoutMs?: number }>;
  /** Human-readable evidence items the agent should report */
  requiredEvidence?: string[];
}

export interface ParsedPlan {
  reasoning: string;
  tasks: ParsedTask[];
}

// Fuzzy agent ID correction. DeepSeek often invents names instead of using real IDs.
// This maps ANY plausible alias to the correct agent ID.

function buildAgentAliasMap(availableAgentIds: string[], allAgents: Array<{ id: string; name: string; capabilities: string[] }>): Map<string, string> {
  const map = new Map<string, string>();
  for (const agentId of availableAgentIds) {
    const a = allAgents.find((ag) => ag.id === agentId);
    if (!a) continue;
    const nameLower = a.name.toLowerCase();
    const caps = a.capabilities.map((c) => c.toLowerCase());

    // Direct name match
    map.set(nameLower, a.id);

    // Keyword-based matching: which capabilities does this agent have?
    const isFrontend = caps.some((c) => ["frontend", "react", "html", "css", "javascript", "web"].some((k) => c.includes(k))) || nameLower.includes("前端");
    const isDesigner = caps.some((c) => ["design", "ui", "visual"].some((k) => c.includes(k))) || nameLower.includes("设计");
    const isPM = caps.some((c) => ["requirements", "prd", "product"].some((k) => c.includes(k))) || nameLower.includes("pm") || nameLower.includes("产品");
    const isReviewer = caps.some((c) => ["review", "qa", "analysis"].some((k) => c.includes(k))) || nameLower.includes("review");

    // Map common LLM-made-up names
    if (isFrontend) for (const alias of ["frontend", "web_dev", "app_developer", "app-dev", "developer", "coder", "fe", "front_end", "front-end", "builder", "web", "dev", "engineer", "programmer"]) map.set(alias, a.id);
    if (isDesigner) for (const alias of ["designer", "ui_designer", "ui", "ux", "visual", "design"]) map.set(alias, a.id);
    if (isPM) for (const alias of ["pm", "product_manager", "po", "product", "manager"]) map.set(alias, a.id);
    if (isReviewer) for (const alias of ["reviewer", "code_reviewer", "qa", "tester", "review", "auditor"]) map.set(alias, a.id);
  }
  return map;
}

/** Try to guess which agent the LLM meant based on task description keywords */
function guessAgentFromTask(agentId: string, taskPrompt: string, availableAgents: Array<{ id: string; name: string; capabilities: string[] }>): string | null {
  const lower = `${agentId} ${taskPrompt}`.toLowerCase();
  // Score each agent by keyword matches in the task
  let bestScore = 0;
  let bestId: string | null = null;
  for (const a of availableAgents) {
    let score = 0;
    for (const cap of a.capabilities) {
      if (lower.includes(cap.toLowerCase())) score += 2;
    }
    if (lower.includes(a.name.toLowerCase())) score += 3;
    // Heuristic: if task mentions code/html/css/js, it's frontend
    if (/html|css|javascript|js|代码|前端|code|编程/.test(lower) && a.capabilities.some((c) => ["frontend", "react", "html", "css", "javascript"].some((k) => c.includes(k)))) score += 5;
    // If task mentions design/UI/颜色/样式, it's designer
    if (/设计|design|ui|颜色|样式|风格|配色/.test(lower) && a.capabilities.some((c) => ["design", "ui", "visual"].some((k) => c.includes(k)))) score += 5;
    // If task mentions review/审查/检查, it's reviewer
    if (/审查|review|检查|验证|测试|test/.test(lower) && a.capabilities.some((c) => ["review", "qa", "analysis"].some((k) => c.includes(k)))) score += 5;
    if (score > bestScore) { bestScore = score; bestId = a.id; }
  }
  return bestScore >= 3 ? bestId : null;
}

export function correctAgentIds(tasks: Array<{ agentId: string; prompt?: string; task?: string }>, aliasMap: Map<string, string>, allAgents: Array<{ id: string; name: string; capabilities: string[] }>): number {
  let count = 0;
  for (const t of tasks) {
    if (allAgents.some((agent) => agent.id === t.agentId)) {
      continue;
    }
    const lower = t.agentId.toLowerCase();
    // 1. Exact alias match
    const corrected = aliasMap.get(lower);
    if (corrected && corrected !== t.agentId) {
      t.agentId = corrected;
      count++;
      continue;
    }
    // 2. Fuzzy: try to guess from task description
    const desc = t.prompt ?? t.task ?? "";
    const guessed = guessAgentFromTask(t.agentId, desc, allAgents);
    if (guessed && guessed !== t.agentId) {
      t.agentId = guessed;
      count++;
    }
  }
  return count;
}

export function parsePlanArgs(args: unknown): ParsedPlan | string {
  const parsed = planArgsSchema.safeParse(args);
  if (!parsed.success) return `Invalid plan: ${parsed.error.message}`;

  const tasks: ParsedTask[] = parsed.data.tasks.map((t) => ({
    id: t.id,
    agentId: t.agentId,
    title: t.title,
    prompt: t.prompt,
    dependsOn: t.dependsOn ?? [],
    inputs: (t.inputs ?? []).map((i) => ({ ...i, required: i.required ?? true })),
    expectedOutputs: (t.expectedOutputs ?? []).map((o) => ({ ...o, required: o.required ?? true })),
    acceptanceCriteria: t.acceptanceCriteria ?? [],
    maxAttempts: t.maxAttempts ?? 1,
    targetPaths: t.targetPaths ?? [],
    requiredCommands: t.requiredCommands ?? [],
    requiredEvidence: t.requiredEvidence ?? []
  }));

  return { reasoning: parsed.data.reasoning, tasks };
}

export function validatePlan(
  tasks: Array<{ id: string; agentId: string; dependsOn?: string[] }>,
  availableAgentIds?: string[]
): string | null {
  const ids = new Set(tasks.map((t) => t.id));

  // Duplicate IDs
  if (ids.size !== tasks.length) return "Duplicate task IDs found.";

  // Empty
  if (tasks.length === 0) return "Plan must contain at least one task.";

  // Unknown agentId
  if (availableAgentIds) {
    for (const t of tasks) {
      if (!availableAgentIds.includes(t.agentId)) {
        return `Task "${t.id}" references unknown agent "${t.agentId}". Available agents: ${availableAgentIds.join(", ")}`;
      }
    }
  }

  // Self-dependency
  for (const t of tasks) {
    if ((t.dependsOn ?? []).includes(t.id)) return `Task "${t.id}" depends on itself.`;
  }

  // Unknown dependency
  for (const t of tasks) {
    for (const dep of t.dependsOn ?? []) {
      if (!ids.has(dep)) return `Task "${t.id}" depends on unknown task "${dep}".`;
    }
  }

  // Cycle detection via DFS
  const visiting = new Set<string>();
  const visited = new Set<string>();

  function hasCycle(taskId: string): boolean {
    if (visiting.has(taskId)) return true;
    if (visited.has(taskId)) return false;
    visiting.add(taskId);
    const task = tasks.find((t) => t.id === taskId);
    if (task) {
      for (const dep of task.dependsOn ?? []) {
        if (hasCycle(dep)) return true;
      }
    }
    visiting.delete(taskId);
    visited.add(taskId);
    return false;
  }

  for (const t of tasks) {
    if (hasCycle(t.id)) return "Plan contains a circular dependency.";
  }

  return null;
}

/** Topological sort returning parallel waves. */
export function topologicalWaves(tasks: ParsedTask[]): ParsedTask[][] {
  const inDegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  const taskMap = new Map(tasks.map((t) => [t.id, t]));

  for (const t of tasks) {
    const internalDependencies = t.dependsOn.filter((dependencyId) => taskMap.has(dependencyId));
    inDegree.set(t.id, internalDependencies.length);
    for (const dep of internalDependencies) {
      const list = dependents.get(dep) ?? [];
      list.push(t.id);
      dependents.set(dep, list);
    }
  }

  const waves: ParsedTask[][] = [];
  let queue = tasks.filter((t) => inDegree.get(t.id) === 0);

  while (queue.length > 0) {
    waves.push(queue);
    const next: ParsedTask[] = [];
    for (const t of queue) {
      for (const dep of dependents.get(t.id) ?? []) {
        const newDegree = (inDegree.get(dep) ?? 1) - 1;
        inDegree.set(dep, newDegree);
        if (newDegree === 0) {
          next.push(taskMap.get(dep)!);
        }
      }
    }
    queue = next;
  }

  return waves;
}
