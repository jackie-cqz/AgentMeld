import type { BenchmarkRole } from "@/server/context-metrics/benchmark-types";
import type { ContextTraceRunTask } from "@/server/context-trace/context-trace-types";

const ROLE_PATTERNS: Array<[BenchmarkRole, RegExp]> = [
  ["conductor", /(?:^|[^a-z0-9])conductor(?:$|[^a-z0-9])/i],
  ["frontend", /(?:^|[^a-z0-9])(?:frontend|front-end|builder|mock_builder)(?:$|[^a-z0-9])|前端/i],
  ["reviewer", /(?:^|[^a-z0-9])(?:reviewer|review|qa)(?:$|[^a-z0-9])|审查|评审/i],
  ["ui", /(?:^|[^a-z0-9])(?:ui|ux|designer|design)(?:$|[^a-z0-9])|设计/i],
  ["pm", /(?:^|[^a-z0-9])pm(?:$|[^a-z0-9])|(?:^|[^a-z0-9])product(?:$|[^a-z0-9])|产品/i],
];

export function inferBenchmarkRole(task: Pick<ContextTraceRunTask, "agentId" | "title">): BenchmarkRole | null {
  const haystack = `${task.agentId} ${task.title}`;
  for (const [role, pattern] of ROLE_PATTERNS) {
    if (pattern.test(haystack)) return role;
  }
  return null;
}

export function findTasksByRole(tasks: ContextTraceRunTask[], role: BenchmarkRole): ContextTraceRunTask[] {
  return tasks.filter((task) => inferBenchmarkRole(task) === role);
}
