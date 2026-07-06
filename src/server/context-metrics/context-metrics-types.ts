// ---------------------------------------------------------------------------
// P3: Context Quality Metrics types
// ---------------------------------------------------------------------------

/** Raw metrics from a single conductor run */
export interface ContextQualityRunMetrics {
  runId: string;
  taskCount: number;
  attemptCount: number;
  completedTaskCount: number;
  failedTaskCount: number;

  verifiedInputCount: number;
  missingRequiredInputCount: number;
  upstreamInputReadCount: number;
  upstreamInputUnreadCount: number;

  contextIncludedItemCount: number;
  contextOmittedItemCount: number;
  contextOmittedByBudgetCount: number;
  staleRejectedCount: number;
  unverifiedRejectedCount: number;
  unrelatedRejectedCount: number;

  evidenceCount: number;
  toolCallCount: number;
  failedToolCallCount: number;
  verifiedOutputBindingCount: number;
  rejectedOutputClaimCount: number;

  artifactCreatedCount: number;
  webAppOutputCount: number;
  deploymentReadyCount: number;
}

/** Derived rates computed from raw metrics */
export interface ContextQualityDerivedRates {
  /** verifiedInputCount / max(expectedUpstreamInputCount, 1) */
  upstreamInputHitRate: number;
  /** upstreamInputReadCount / max(verifiedInputCount, 1) */
  upstreamArtifactReadRate: number;
  /** contextOmittedItemCount / max(totalCandidateCount, 1) */
  contextOmissionRate: number;
  /** rejectedOutputClaimCount / max(totalOutputClaimCount, 1) */
  unverifiedOutputRejectionRate: number;
  /** failedToolCallCount / max(toolCallCount, 1) */
  toolFailureRate: number;
  /** attemptCount - taskCount (retries) / max(taskCount, 1) */
  taskRetryRate: number;
  /** deploymentReadyCount / max(webAppOutputCount, 1) */
  deploymentSuccessRate: number;
  /** completedTaskCount / max(taskCount, 1) */
  taskCompletionRate: number;
}

export interface ContextQualityReport {
  runId: string;
  raw: ContextQualityRunMetrics;
  derived: ContextQualityDerivedRates;
}

export interface FixtureReportEntry {
  fixtureId: string;
  runId: string;
  status: "passed" | "failed" | "error";
  report: ContextQualityReport;
  warnings: string[];
  evaluatedAt: number;
}

export interface FixtureReportSummary {
  generatedAt: number;
  totalFixtures: number;
  passed: number;
  failed: number;
  errors: number;
  overallPassRate: number;
  entries: FixtureReportEntry[];
}
