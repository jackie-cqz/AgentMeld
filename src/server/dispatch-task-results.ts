declare global {
  var __agentMeldTaskResults: Map<string, DispatchTaskReport> | undefined;
  var __agentMeldTaskArtifacts: Map<string, Record<string, string>> | undefined;
}

export interface DispatchTaskReport {
  taskId: string;
  runId: string;
  status: "complete" | "failed" | "blocked";
  summary: string;
  acceptanceResults: Array<{ criterion: string; passed: boolean; evidence: string }>;
  blockers: string[];
  /** outputKey → artifactId mapping for produced artifacts */
  artifacts: Record<string, string>;
  /** Files created/modified/deleted during task execution */
  files?: Array<{ path: string; action?: "created" | "modified" | "deleted" | "read"; summary?: string }>;
  /** Commands executed with exit codes */
  commands?: Array<{ command: string; exitCode: number; passed?: boolean; summary?: string }>;
  /** Test commands that passed or failed */
  tests?: Array<{ command: string; passed: boolean; summary?: string }>;
}

function getStore(): Map<string, DispatchTaskReport> {
  if (!globalThis.__agentMeldTaskResults) {
    globalThis.__agentMeldTaskResults = new Map();
  }
  return globalThis.__agentMeldTaskResults;
}

function getArtifactStore(): Map<string, Record<string, string>> {
  if (!globalThis.__agentMeldTaskArtifacts) {
    globalThis.__agentMeldTaskArtifacts = new Map();
  }
  return globalThis.__agentMeldTaskArtifacts;
}

export function recordTaskArtifact(runId: string, outputKey: string, artifactId: string): void {
  const store = getArtifactStore();
  const existing = store.get(runId) ?? {};
  store.set(runId, { ...existing, [outputKey]: artifactId });
}

export function recordTaskReport(runId: string, report: DispatchTaskReport): void {
  // Merge artifacts if report already exists (e.g., multiple write_artifact calls)
  const existing = getStore().get(runId);
  const recordedArtifacts = getArtifactStore().get(runId) ?? {};
  if (existing) {
    report.artifacts = { ...existing.artifacts, ...report.artifacts };
  }
  report.artifacts = { ...recordedArtifacts, ...report.artifacts };
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
  getArtifactStore().delete(runId);
}

export function clearAllTaskResultsForTests(): void {
  getStore().clear();
  getArtifactStore().clear();
}
