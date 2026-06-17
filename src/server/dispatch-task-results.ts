declare global {
  var __agentConferenceTaskResults: Map<string, DispatchTaskReport> | undefined;
}

export interface DispatchTaskReport {
  taskId: string;
  runId: string;
  status: "complete" | "failed" | "blocked";
  summary: string;
  acceptanceResults: Array<{ criterion: string; passed: boolean; evidence: string }>;
  blockers: string[];
  artifacts: Record<string, string>; // outputKey → artifactId
}

function getStore(): Map<string, DispatchTaskReport> {
  if (!globalThis.__agentConferenceTaskResults) {
    globalThis.__agentConferenceTaskResults = new Map();
  }
  return globalThis.__agentConferenceTaskResults;
}

export function recordTaskReport(runId: string, report: DispatchTaskReport): void {
  getStore().set(runId, report);
}

export function getTaskReport(runId: string): DispatchTaskReport | undefined {
  return getStore().get(runId);
}

/** Evaluate if a task truly succeeded based on its report. */
export function evaluateTaskResult(report: DispatchTaskReport | undefined): {
  status: "complete" | "failed" | "blocked" | "skipped";
  error?: string;
} {
  if (!report) {
    return { status: "failed", error: "Child run did not call report_task_result." };
  }

  if (report.status === "failed" || report.status === "blocked") {
    return {
      status: report.status === "blocked" ? "failed" : "failed",
      error: `Task reported ${report.status}: ${report.summary}`
    };
  }

  // Check acceptance criteria
  const failedCriteria = report.acceptanceResults.filter((a) => !a.passed);
  if (failedCriteria.length > 0) {
    return {
      status: "failed",
      error: `Acceptance criteria not met: ${failedCriteria.map((a) => a.criterion).join(", ")}`
    };
  }

  return { status: "complete" };
}

export function clearTaskResultsForRun(runId: string): void {
  getStore().delete(runId);
}

export function clearAllTaskResultsForTests(): void {
  getStore().clear();
}
