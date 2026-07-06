// ---------------------------------------------------------------------------
// P2: E2E runner shared types
// ---------------------------------------------------------------------------

export interface E2EFixture {
  id: string;
  title: string;
  description: string;
  userPrompt: string;
  expectedTasks: string[];
  expectedOutputs: Array<{
    taskRole: string;
    outputKey: string;
    type: "web_app" | "document" | "image" | "ppt";
  }>;
  requiredToolEvidence: string[];
  successCriteria: string[];
  /** Minimum number of success criteria that must pass */
  minPassCriteria: number;
}

export interface E2ERunResult {
  fixtureId: string;
  runId: string;
  startedAt: number;
  finishedAt: number;
  status: "passed" | "failed" | "error";
  /** P7: Context strategy used for this run */
  strategy?: string;
  metrics: E2ERunMetrics;
  criteriaResults: Array<{ criterion: string; passed: boolean; detail: string }>;
  artifacts: Array<{ outputKey: string; artifactId: string; type: string; title: string }>;
  warnings: string[];
  error?: string;
}

/** P7: Compare two E2E runs with different strategies */
export interface StrategyComparisonEntry {
  fixtureId: string;
  baseline: { strategy: string; status: string; metrics: Pick<E2ERunMetrics, "taskCount" | "attemptCount" | "completedTaskCount" | "upstreamInputReadCount" | "verifiedInputCount" | "failedToolCallCount" | "deploymentReadyCount"> };
  candidate: { strategy: string; status: string; metrics: Pick<E2ERunMetrics, "taskCount" | "attemptCount" | "completedTaskCount" | "upstreamInputReadCount" | "verifiedInputCount" | "failedToolCallCount" | "deploymentReadyCount"> };
}

export interface StrategyComparisonReport {
  baselineStrategy: string;
  candidateStrategy: string;
  comparedAt: number;
  fixtures: StrategyComparisonEntry[];
  summary: {
    baselinePassRate: number;
    candidatePassRate: number;
    baselineAvgReadRate: number;
    candidateAvgReadRate: number;
    baselineAvgDeployRate: number;
    candidateAvgDeployRate: number;
  };
}

export interface E2ERunMetrics {
  taskCount: number;
  attemptCount: number;
  completedTaskCount: number;
  failedTaskCount: number;
  verifiedInputCount: number;
  missingRequiredInputCount: number;
  upstreamInputReadCount: number;
  upstreamInputUnreadCount: number;
  toolCallCount: number;
  failedToolCallCount: number;
  verifiedOutputBindingCount: number;
  rejectedOutputClaimCount: number;
  artifactCreatedCount: number;
  webAppOutputCount: number;
  deploymentReadyCount: number;
}
