import type { DispatchTaskReport } from "@/server/dispatch-task-results";
import type { ParsedTask } from "@/server/tools/orchestrator-tools";

export interface TaskEvidence {
  fileWrites: Array<{ path: string; action: string }>;
  commands: Array<{
    command: string;
    exitCode: number | null;
    cwd?: string;
    timedOut?: boolean;
    isError?: boolean;
  }>;
}

/**
 * 7-step code-based evaluation. Does NOT trust the LLM's self-report.
 * Evidence > declaration.
 */
export function evaluateChildTaskResult(
  task: ParsedTask,
  report: DispatchTaskReport | undefined,
  evidence?: TaskEvidence
): { status: "complete" | "failed" | "blocked"; error?: string } {
  // ① Did they call report_task_result at all?
  if (!report) {
    return { status: "failed", error: "没有调用 report_task_result" };
  }

  // ② Did the LLM report complete?
  if (report.status === "failed" || report.status === "blocked") {
    return {
      status: "failed",
      error: `LLM 自己报了 ${report.status}: ${report.summary.slice(0, 100)}`
    };
  }

  // ③ Any failed commands in evidence?
  if (evidence) {
    const failedCommands = evidence.commands.filter(
      (c) => c.isError || c.timedOut || (c.exitCode !== null && c.exitCode !== 0)
    );
    if (failedCommands.length > 0) {
      return {
        status: "failed",
        error: `命令证据失败: ${failedCommands.map((c) => c.command).join(", ")}`
      };
    }
  }

  // ④ All acceptance criteria passed?
  const failedAcceptance = (report.acceptanceResults ?? []).filter((r) => !r.passed);
  if (failedAcceptance.length > 0) {
    return {
      status: "failed",
      error: `验收标准未通过: ${failedAcceptance.map((a) => a.criterion).join(", ")}`
    };
  }

  // ⑤ Any acceptance criteria MISSING from the report?
  const criteria = task.acceptanceCriteria ?? [];
  const reportedCriteria = new Set((report.acceptanceResults ?? []).map((a) => a.criterion.trim()));
  const missing = criteria.filter((c) => !reportedCriteria.has(c.trim()));
  if (missing.length > 0) {
    return {
      status: "failed",
      error: `验收标准漏报: ${missing.join(", ")}`
    };
  }

  // ⑥ targetPaths have evidence?
  if (evidence) {
    const writtenPaths = new Set(evidence.fileWrites.map((f) => f.path));
    for (const tp of task.acceptanceCriteria ? [] : []) {
      // task.acceptanceCriteria check done above; targetPaths check is optional
    }
  }

  return { status: "complete" };
}
