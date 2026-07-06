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
  metrics: E2ERunMetrics;
  criteriaResults: Array<{ criterion: string; passed: boolean; detail: string }>;
  artifacts: Array<{ outputKey: string; artifactId: string; type: string; title: string }>;
  warnings: string[];
  error?: string;
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
