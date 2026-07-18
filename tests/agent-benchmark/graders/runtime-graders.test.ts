import { describe, expect, it } from "vitest";

import type {
  AgentBenchmarkCase,
  BenchmarkRuntimeValidation,
} from "@/server/context-metrics/benchmark-types";
import type { ContextTraceRunResponse } from "@/server/context-trace/context-trace-types";

import { evaluateBenchmarkTrace, reviewerTasksPassed } from "../evaluate-case";

const benchmarkCase: AgentBenchmarkCase = {
  schemaVersion: 1,
  id: "runtime-validation",
  title: "Runtime validation",
  description: "Validates persisted artifact, build, HTTP preview, and browser interaction evidence.",
  category: "collaboration",
  prompt: "Build an app.",
  expectedRoles: ["frontend"],
  assertions: [
    { id: "artifact", type: "artifact_valid", role: "frontend", outputKey: "web_app", artifactType: "web_app", minContentBytes: 100, requiredFiles: ["index.html"], required: true },
    { id: "build", type: "build_succeeded", role: "frontend", commandPattern: "build", required: true },
    { id: "preview", type: "preview_http", role: "frontend", outputKey: "web_app", expectedStatus: 200, minBodyBytes: 20, required: true },
    { id: "browser", type: "browser_interaction", scriptId: "core", required: true },
  ],
  limits: { maxDurationMs: 1000 },
  tags: ["unit"],
};

describe("P3 runtime graders", () => {
  it("treats optional missing reviewer verdicts as non-blocking", () => {
    const reviewerTask = {
      ...trace().tasks[0],
      verdicts: [{
        id: "vd_optional",
        criterionId: "optional-review",
        validatorType: "reviewer_verdict",
        status: "missing" as const,
        evidenceIds: [],
        reason: "optional",
      }]
    };

    expect(reviewerTasksPassed([reviewerTask])).toBe(true);
    expect(reviewerTasksPassed([{
      ...reviewerTask,
      verdicts: [{ ...reviewerTask.verdicts[0], status: "failed" as const }]
    }])).toBe(false);
  });

  it("passes only from concrete runtime validation records", () => {
    const result = evaluateBenchmarkTrace(benchmarkCase, trace(), { runtimeValidation: validation() });
    expect(result.status).toBe("passed");
    expect(result.assertionResults.map((item) => item.status)).toEqual(["passed", "passed", "passed", "passed"]);
  });

  it("does not allow successful self-reports to override a broken preview", () => {
    const runtimeValidation = validation();
    runtimeValidation.previews[0] = { ...runtimeValidation.previews[0], status: 404, error: "HTTP 404" };
    const result = evaluateBenchmarkTrace(benchmarkCase, trace(), { runtimeValidation });
    expect(result.status).toBe("failed");
    expect(result.assertionResults.find((item) => item.assertionId === "preview")?.reason).toContain("404");
  });

  it("fails browser assertions on console errors even when steps pass", () => {
    const runtimeValidation = validation();
    runtimeValidation.browsers[0].status = "failed";
    runtimeValidation.browsers[0].consoleErrors.push("Uncaught TypeError");
    const result = evaluateBenchmarkTrace(benchmarkCase, trace(), { runtimeValidation });
    expect(result.status).toBe("failed");
    expect(result.assertionResults.find((item) => item.assertionId === "browser")?.reason).toContain("Uncaught TypeError");
  });

  it("keeps non-blocking external request diagnostics from overriding a passed browser run", () => {
    const runtimeValidation = validation();
    runtimeValidation.browsers[0].consoleErrors.push("Failed to load resource: net::ERR_CONNECTION_CLOSED");
    runtimeValidation.browsers[0].failedRequests.push("GET https://example.invalid/image.png: failed");

    const result = evaluateBenchmarkTrace(benchmarkCase, trace(), { runtimeValidation });
    expect(result.status).toBe("passed");
    expect(result.assertionResults.find((item) => item.assertionId === "browser")?.reason)
      .toContain("non-blocking external request");
  });
});

function validation(): BenchmarkRuntimeValidation {
  return {
    collectedAt: 10,
    artifacts: [{ taskId: "r1", outputKey: "web_app", artifactId: "art_app", artifactType: "web_app", title: "App", contentBytes: 500, files: ["index.html", "assets/app.js"], valid: true, errors: [] }],
    builds: [{ taskId: "r1", evidenceId: "ev_build", command: "pnpm build", exitCode: 0, timedOut: false, status: "valid", outputExcerpt: "built" }],
    deployments: [{ taskId: "r1", outputKey: "web_app", artifactId: "art_app", evidenceId: "ev_deploy", toolCallId: "call_deploy", previewPath: "/deployments/dep_1", previewUrl: "http://127.0.0.1/deployments/dep_1", ready: true }],
    previews: [{ outputKey: "web_app", artifactId: "art_app", previewUrl: "http://127.0.0.1/deployments/dep_1", status: 200, bodyBytes: 500, contentType: "text/html", error: null }],
    browsers: [{ scriptId: "core", outputKey: "web_app", previewUrl: "http://127.0.0.1/deployments/dep_1", status: "passed", steps: [{ index: 0, action: "click", status: "passed", detail: "click button" }], consoleErrors: [], pageErrors: [], failedRequests: [], screenshotPath: "C:/tmp/core.png", error: null }],
    toolRejections: [],
    injectedFaults: [],
    approvals: [],
  };
}

function trace(): ContextTraceRunResponse {
  return {
    conductorRunId: "run_1",
    conversationId: "conv_1",
    planId: "plan_1",
    tasks: [{
      taskId: "r1",
      agentId: "ag_mock_builder",
      title: "Frontend implementation",
      dependsOn: [],
      attempts: [{ conversationId: "conv_1", conductorRunId: "run_1", planId: "plan_1", taskId: "r1", attemptId: "att_1", agentId: "ag_mock_builder", contextSnapshotId: "ctx_1", executionStatus: "reported_complete", verificationStatus: "verified", startedAt: 1, finishedAt: 2 }],
      producedBindings: [{ producerTaskId: "r1", outputKey: "web_app", artifactId: "art_app", artifactTitle: "App", artifactType: "web_app", createdAt: 2 }],
      consumedInputs: [],
      evidence: [],
      verdicts: [],
      warnings: [],
    }],
    metrics: {
      taskCount: 1, attemptCount: 1, completedTaskCount: 1, failedTaskCount: 0,
      verifiedInputCount: 0, missingRequiredInputCount: 0, upstreamInputReadCount: 0, upstreamInputUnreadCount: 0,
      contextIncludedItemCount: 0, contextOmittedItemCount: 0, contextOmittedByBudgetCount: 0, contextOmittedReasonCounts: {},
      staleRejectedCount: 0, staleFactLeakageCount: 0, unverifiedRejectedCount: 0, unrelatedRejectedCount: 0, evidenceCount: 2,
      toolCallCount: 2, failedToolCallCount: 0, verifiedOutputBindingCount: 1, rejectedOutputClaimCount: 0, unverifiedOutputPropagationCount: 0,
      approvalRequestCount: 0, jsonRepairCount: 0, inputTokens: 10, outputTokens: 5, modelRunCount: 1,
      verifiedTaskCount: 1, rejectedTaskCount: 0, needsReviewTaskCount: 0,
      artifactCreatedCount: 1, webAppOutputCount: 1, deploymentReadyCount: 1,
    },
  };
}
