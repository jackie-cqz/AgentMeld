import { describe, expect, it } from "vitest";

import type {
  AgentBenchmarkCase,
  BenchmarkRuntimeValidation,
} from "@/server/context-metrics/benchmark-types";
import type { ContextTraceRunResponse } from "@/server/context-trace/context-trace-types";

import { evaluateBenchmarkTrace } from "../evaluate-case";

describe("workspace and hidden verifier graders", () => {
  it("passes only when every required runtime assertion has concrete evidence", () => {
    const result = evaluateBenchmarkTrace(benchmarkCase(), trace(), {
      runtimeValidation: validation(),
    });

    expect(result.status).toBe("passed");
    expect(result.assertionResults.map((item) => item.status)).toEqual([
      "passed", "passed", "passed", "passed",
    ]);
  });

  it("fails the case when the hidden verifier reports a non-zero exit", () => {
    const runtimeValidation = validation();
    runtimeValidation.verifiers![0] = {
      ...runtimeValidation.verifiers![0],
      status: "failed",
      exitCode: 1,
      stderr: "hidden assertion failed",
    };
    const result = evaluateBenchmarkTrace(benchmarkCase(), trace(), {
      runtimeValidation,
    });

    expect(result.status).toBe("failed");
    expect(result.assertionResults[0].reason).toContain("hidden assertion failed");
  });
});

function benchmarkCase(): AgentBenchmarkCase {
  return {
    schemaVersion: 1,
    id: "workspace-verifier-graders",
    title: "Workspace verifier graders",
    description: "Grades trusted post-run evidence.",
    category: "recovery",
    prompt: "Repair the workspace.",
    expectedRoles: ["frontend"],
    assertions: [
      { id: "verify", type: "command_verifier", verifierId: "hidden", required: true },
      { id: "file", type: "workspace_file", path: "result.txt", minBytes: 3, contentPatterns: ["done"], required: true },
      { id: "json", type: "structured_output", path: "report.json", format: "json", requiredKeys: ["status"], required: true },
      { id: "mutation", type: "no_forbidden_mutation", paths: ["README.md"], required: true },
    ],
    limits: { maxDurationMs: 1000 },
    runtime: { verifiers: [{ id: "hidden", command: "node hidden.mjs" }] },
    tags: ["unit"],
  };
}

function validation(): BenchmarkRuntimeValidation {
  return {
    collectedAt: 1,
    artifacts: [],
    builds: [],
    deployments: [],
    previews: [],
    browsers: [],
    toolRejections: [],
    toolCalls: [],
    injectedFaults: [],
    approvals: [],
    verifiers: [{
      verifierId: "hidden",
      command: "node hidden.mjs",
      status: "passed",
      exitCode: 0,
      expectedExitCode: 0,
      timedOut: false,
      durationMs: 10,
      stdout: "ok",
      stderr: "",
      error: null,
    }],
    workspaceFiles: [{
      path: "result.txt",
      exists: true,
      isFile: true,
      bytes: 4,
      sha256: "abc",
      contentText: "done",
      error: null,
    }],
    structuredOutputs: [{
      path: "report.json",
      format: "json",
      valid: true,
      recordCount: 1,
      keys: ["status"],
      errors: [],
    }],
    mutations: [{
      path: "README.md",
      beforeSha256: "same",
      afterSha256: "same",
      unchanged: true,
      error: null,
    }],
  };
}

function trace(): ContextTraceRunResponse {
  return {
    conductorRunId: "run_hidden",
    conversationId: "conv_hidden",
    planId: "plan_hidden",
    tasks: [],
    metrics: {
      taskCount: 0,
      attemptCount: 0,
      completedTaskCount: 0,
      failedTaskCount: 0,
      verifiedInputCount: 0,
      missingRequiredInputCount: 0,
      upstreamInputReadCount: 0,
      upstreamInputUnreadCount: 0,
      contextIncludedItemCount: 0,
      contextOmittedItemCount: 0,
      contextOmittedByBudgetCount: 0,
      contextOmittedReasonCounts: {},
      staleRejectedCount: 0,
      staleFactLeakageCount: 0,
      unverifiedRejectedCount: 0,
      unrelatedRejectedCount: 0,
      evidenceCount: 0,
      toolCallCount: 0,
      failedToolCallCount: 0,
      verifiedOutputBindingCount: 0,
      rejectedOutputClaimCount: 0,
      unverifiedOutputPropagationCount: 0,
      approvalRequestCount: 0,
      jsonRepairCount: 0,
      inputTokens: 0,
      outputTokens: 0,
      modelRunCount: 0,
      verifiedTaskCount: 0,
      rejectedTaskCount: 0,
      needsReviewTaskCount: 0,
      artifactCreatedCount: 0,
      webAppOutputCount: 0,
      deploymentReadyCount: 0,
    },
  };
}
