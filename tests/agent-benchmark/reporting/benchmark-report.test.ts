import { describe, expect, it } from "vitest";

import { countToolRetries, emptyRunMetrics } from "../evaluate-case";
import { buildBenchmarkReport } from "./benchmark-report";
import type { E2ERunResult } from "../../e2e-runner/types";

describe("buildBenchmarkReport", () => {
  it("counts tool retries separately by stable attempt, tool, and arguments", () => {
    const common = {
      runId: "run_child",
      taskId: "t1",
      attemptId: "att_1",
      toolName: "deploy_workspace",
      status: "succeeded" as const,
      result: {},
    };
    expect(countToolRetries([
      { ...common, callId: "call_1", args: { path: "dist", outputKey: "web_app" }, sequence: 1 },
      { ...common, callId: "call_2", args: { outputKey: "web_app", path: "dist" }, sequence: 2 },
      { ...common, callId: "call_3", toolName: "fs_read", args: { path: "dist/index.html" }, sequence: 3 },
      { ...common, callId: "call_4", toolName: "fs_read", args: { path: "src/App.tsx" }, sequence: 4 },
    ])).toBe(1);
  });

  it("maps collected P2 metrics without fixed zero placeholders", () => {
    const result: E2ERunResult = {
      fixtureId: "p2-real-metrics",
      runId: "run_p2",
      startedAt: 100,
      finishedAt: 250,
      status: "passed",
      strategy: "evidence_aware_context",
      metrics: {
        ...emptyRunMetrics(),
        taskCount: 4,
        attemptCount: 5,
        completedTaskCount: 4,
        verifiedInputCount: 3,
        missingRequiredInputCount: 1,
        upstreamInputReadCount: 2,
        contextIncludedItemCount: 8,
        contextOmittedItemCount: 2,
        contextOmittedReasonCounts: { stale: 1, unrelated: 1 },
        staleRejectedCount: 1,
        toolCallCount: 10,
        failedToolCallCount: 2,
        toolRetryCount: 2,
        approvalRequestCount: 3,
        jsonRepairCount: 2,
        inputTokens: 1200,
        outputTokens: 340,
        modelRunCount: 5,
        expectedRoleCount: 4,
        executedExpectedRoleCount: 3,
        expectedOutputCount: 4,
        verifiedExpectedOutputCount: 3,
        reviewerPassed: true,
        rejectedOutputClaimCount: 3,
        unverifiedOutputPropagationCount: 1,
      },
      assertionResults: [{
        assertionId: "deployment-ready",
        type: "deployment_ready",
        required: true,
        status: "passed",
        score: 1,
        maxScore: 1,
        reason: "ready",
        references: [],
      }],
      artifacts: [],
      warnings: [],
    };

    const report = buildBenchmarkReport([result], "evidence_aware_context");
    const metrics = report.cases[0];

    expect(metrics.contextOmissionRate).toBe(0.2);
    expect(metrics.contextOmittedReasonCounts).toEqual({ stale: 1, unrelated: 1 });
    expect(metrics.staleFactRejectedCount).toBe(1);
    expect(metrics.approvalRequestCount).toBe(3);
    expect(metrics.jsonRepairCount).toBe(2);
    expect(metrics.inputTokens).toBe(1200);
    expect(metrics.outputTokens).toBe(340);
    expect(metrics.estimatedInputTokens).toBe(1200);
    expect(metrics.expectedRoleCoverage).toBe(0.75);
    expect(metrics.expectedOutputCoverage).toBe(0.75);
    expect(metrics.verifiedInputCoverage).toBe(0.75);
    expect(metrics.upstreamArtifactReadRate).toBeCloseTo(2 / 3);
    expect(metrics.toolFailureRate).toBe(0.2);
    expect(metrics.taskRetryCount).toBe(1);
    expect(metrics.retryCount).toBe(1);
    expect(metrics.toolRetryCount).toBe(2);
    expect(metrics.unverifiedOutputBlockedCount).toBe(3);
    expect(metrics.unverifiedOutputPropagationCount).toBe(1);
    expect(metrics.reviewerPassed).toBe(true);
  });

  it("uses explicit zero-denominator semantics without NaN", () => {
    const result: E2ERunResult = {
      fixtureId: "empty",
      runId: "run_empty",
      startedAt: 0,
      finishedAt: 1,
      status: "passed",
      metrics: emptyRunMetrics(),
      assertionResults: [],
      artifacts: [],
      warnings: [],
    };

    const metrics = buildBenchmarkReport([result], "test").cases[0];
    expect(metrics.expectedRoleCoverage).toBe(1);
    expect(metrics.expectedOutputCoverage).toBe(1);
    expect(metrics.contextOmissionRate).toBe(0);
    expect(metrics.toolFailureRate).toBe(0);
    expect(Number.isNaN(metrics.verifiedInputCoverage)).toBe(false);
  });
});
