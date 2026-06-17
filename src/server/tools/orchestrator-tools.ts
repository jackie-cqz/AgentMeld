import { z } from "zod";
import { recordTaskReport } from "@/server/dispatch-task-results";
import type { ToolDef } from "@/server/tools/types";

// ---------------------------------------------------------------------------
// plan_tasks
// ---------------------------------------------------------------------------

export const planTasksTool: ToolDef = {
  name: "plan_tasks",
  description:
    "Create a plan of subtasks to delegate to other agents. " +
    "Only available to Orchestrator agents. Each task specifies an agent, instructions, and dependencies.",
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
            }
          }
        }
      }
    }
  },
  async handler(args, _ctx) {
    const parsed = planArgsSchema.safeParse(args);
    if (!parsed.success) {
      return { ok: false, error: `Invalid plan: ${parsed.error.message}` };
    }

    const { reasoning, tasks } = parsed.data;

    // Validate
    const validation = validatePlan(tasks);
    if (validation) {
      return { ok: false, error: validation };
    }

    return {
      ok: true,
      value: {
        acknowledged: true,
        taskCount: tasks.length,
        reasoning
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
    "Status must be 'complete', 'failed', or 'blocked'.",
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
      acceptanceResults: {
        type: "array",
        items: {
          type: "object",
          required: ["criterion", "passed", "evidence"],
          properties: {
            criterion: { type: "string" },
            passed: { type: "boolean" },
            evidence: { type: "string" }
          }
        }
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

    // Record task result for orchestrator evaluation (when runId is set)
    if (ctx.runId) {
      recordTaskReport(ctx.runId, {
        taskId: "",
        runId: ctx.runId,
        status: parsed.data.status,
        summary: parsed.data.summary,
        acceptanceResults: parsed.data.acceptanceResults ?? [],
        blockers: parsed.data.blockers ?? [],
        artifacts: {}
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
        maxAttempts: z.number().min(1).max(5).optional()
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
  blockers: z.array(z.string()).optional()
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
}

export interface ParsedPlan {
  reasoning: string;
  tasks: ParsedTask[];
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
    maxAttempts: t.maxAttempts ?? 1
  }));

  return { reasoning: parsed.data.reasoning, tasks };
}

export function validatePlan(tasks: Array<{ id: string; agentId: string; dependsOn?: string[] }>): string | null {
  const ids = new Set(tasks.map((t) => t.id));

  // Duplicate IDs
  if (ids.size !== tasks.length) return "Duplicate task IDs found.";

  // Empty
  if (tasks.length === 0) return "Plan must contain at least one task.";

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
    inDegree.set(t.id, t.dependsOn.length);
    for (const dep of t.dependsOn) {
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
