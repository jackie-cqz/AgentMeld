import type {
  AgentBenchmarkMetrics,
  AgentBenchmarkReport,
} from "@/server/context-metrics/benchmark-types";

import type { E2ERunResult } from "../../e2e-runner/types";

export function buildBenchmarkReport(results: E2ERunResult[], strategy: string): AgentBenchmarkReport {
  const cases: AgentBenchmarkMetrics[] = results.map((result) => {
    const durationMs = result.finishedAt - result.startedAt;
    const edgeResults = result.assertionResults.filter((item) => item.type === "dag_edge");
    const failedEdges = edgeResults.filter((item) => item.status !== "passed");
    const requiredFailures = result.assertionResults.filter((item) => item.required && item.status !== "passed");
    const hasOptionalFailures = result.assertionResults.some((item) => !item.required && item.status === "failed");
    const finalStatus: AgentBenchmarkMetrics["finalStatus"] = result.status === "error" || result.status === "blocked" || result.status === "budget_exceeded"
      ? "blocked"
      : result.status === "failed"
        ? "failed"
        : hasOptionalFailures || result.warnings.length > 0
          ? "partial"
          : "passed";
    const verifiedInputs = result.metrics.verifiedInputCount;
    const taskRetryCount = Math.max(0, result.metrics.attemptCount - result.metrics.taskCount);

    return {
      success: result.status === "passed",
      finalStatus,
      caseId: result.fixtureId,
      runId: result.runId,
      startedAt: result.startedAt,
      finishedAt: result.finishedAt,
      durationMs,
      strategy,
      taskCount: result.metrics.taskCount,
      completedTaskCount: result.metrics.completedTaskCount,
      failedTaskCount: result.metrics.failedTaskCount,
      taskRetryCount,
      toolRetryCount: result.metrics.toolRetryCount,
      retryCount: taskRetryCount,
      planValid: result.metrics.taskCount > 0 && failedEdges.length === 0,
      expectedRoleCoverage: coverage(result.metrics.executedExpectedRoleCount, result.metrics.expectedRoleCount),
      expectedOutputCoverage: coverage(result.metrics.verifiedExpectedOutputCount, result.metrics.expectedOutputCount),
      verifiedInputCount: verifiedInputs,
      verifiedInputCoverage: coverage(
        verifiedInputs,
        verifiedInputs + result.metrics.missingRequiredInputCount,
      ),
      upstreamArtifactReadRate: ratio(result.metrics.upstreamInputReadCount, verifiedInputs),
      contextOmissionRate: ratio(
        result.metrics.contextOmittedItemCount,
        result.metrics.contextIncludedItemCount + result.metrics.contextOmittedItemCount,
      ),
      contextIncludedItemCount: result.metrics.contextIncludedItemCount,
      contextOmittedItemCount: result.metrics.contextOmittedItemCount,
      contextOmittedReasonCounts: result.metrics.contextOmittedReasonCounts,
      staleFactRejectedCount: result.metrics.staleRejectedCount,
      unverifiedOutputBlockedCount: result.metrics.rejectedOutputClaimCount,
      unverifiedOutputPropagationCount: result.metrics.unverifiedOutputPropagationCount,
      toolCallCount: result.metrics.toolCallCount,
      toolFailureRate: ratio(result.metrics.failedToolCallCount, result.metrics.toolCallCount),
      approvalRequestCount: result.metrics.approvalRequestCount,
      jsonRepairCount: result.metrics.jsonRepairCount,
      artifactCreatedCount: result.metrics.artifactCreatedCount,
      deploymentReady: result.assertionResults.some((item) => item.type === "deployment_ready" && item.status === "passed"),
      reviewerPassed: result.metrics.reviewerPassed,
      inputTokens: result.metrics.inputTokens,
      outputTokens: result.metrics.outputTokens,
      modelRunCount: result.metrics.modelRunCount,
      estimatedInputTokens: result.metrics.inputTokens,
      edgesSatisfied: failedEdges.length === 0,
      missingEdges: failedEdges.map((item) => item.reason),
      warnings: [
        ...result.warnings,
        ...requiredFailures.map((item) => `Required assertion failed: ${item.assertionId}`),
        ...(result.error ? [result.error] : []),
      ],
    };
  });

  const passed = cases.filter((item) => item.finalStatus === "passed" || item.finalStatus === "partial").length;
  return {
    generatedAt: Date.now(),
    strategy,
    totalCases: cases.length,
    passed,
    failed: cases.filter((item) => item.finalStatus === "failed").length,
    errors: cases.filter((item) => item.finalStatus === "blocked").length,
    overallSuccessRate: cases.length > 0 ? passed / cases.length : 0,
    cases,
  };
}

function coverage(numerator: number, denominator: number): number {
  return denominator > 0 ? numerator / denominator : 1;
}

function ratio(numerator: number, denominator: number): number {
  return denominator > 0 ? numerator / denominator : 0;
}
