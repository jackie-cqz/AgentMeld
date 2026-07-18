import { describe, expect, it } from "vitest";

import type {
  AgentBenchmarkCase,
  BenchmarkRuntimeValidation,
} from "@/server/context-metrics/benchmark-types";
import type {
  ContextTraceAttempt,
  ContextTraceEvidenceSummary,
  ContextTraceRunResponse,
  ContextTraceRunTask,
} from "@/server/context-trace/context-trace-types";

import { evaluateBenchmarkTrace } from "../evaluate-case";
import { createDefaultBenchmarkGraderRegistry } from "./grader-registry";

const benchmarkCase: AgentBenchmarkCase = {
  schemaVersion: 1,
  id: "deterministic-graders",
  title: "Deterministic graders",
  description: "Exercises every P0 assertion grader.",
  category: "collaboration",
  prompt: "Build an app.",
  expectedRoles: ["pm", "frontend"],
  assertions: [
    { id: "pm-ran", type: "role_executed", role: "pm", required: true },
    { id: "frontend-ran", type: "role_executed", role: "frontend", required: true },
    { id: "pm-to-frontend", type: "dag_edge", fromRole: "pm", toRole: "frontend", outputKey: "prd", required: true },
    { id: "prd-binding", type: "output_binding", role: "pm", outputKey: "prd", artifactType: "document", required: true },
    { id: "app-binding", type: "output_binding", role: "frontend", outputKey: "web_app", artifactType: "web_app", required: true },
    { id: "frontend-read-prd", type: "artifact_read", producerRole: "pm", consumerRole: "frontend", outputKey: "prd", required: true },
    { id: "frontend-build", type: "tool_succeeded", toolName: "bash", role: "frontend", commandPattern: "build", required: true },
    { id: "frontend-deploy", type: "deployment_ready", role: "frontend", outputKey: "web_app", required: true },
    { id: "frontend-retry-bound", type: "retry_bound", role: "frontend", minAttempts: 1, maxAttempts: 2, required: true },
  ],
  limits: { maxDurationMs: 1000, maxAttemptsPerTask: 2 },
  tags: ["unit"],
};

describe("benchmark grader registry", () => {
  it("registers a deterministic grader for every P0 assertion", () => {
    const registry = createDefaultBenchmarkGraderRegistry();
    for (const assertion of benchmarkCase.assertions) expect(registry.has(assertion.type)).toBe(true);
  });

  it("passes a trace that satisfies all required assertions", () => {
    const result = evaluateBenchmarkTrace(benchmarkCase, buildTrace());
    expect(result.status).toBe("passed");
    expect(result.assertionResults).toHaveLength(benchmarkCase.assertions.length);
    expect(result.assertionResults.every((assertion) => assertion.status === "passed")).toBe(true);
    expect(result.assertionResults.find((assertion) => assertion.assertionId === "frontend-build")?.references[0]).toMatchObject({
      evidenceId: "ev_build",
      toolCallId: "call_build",
      taskId: "r2",
    });
  });

  it("fails the case when one required assertion fails", () => {
    const trace = buildTrace();
    trace.tasks[1].consumedInputs[0].readByCurrentAttempt = false;
    const result = evaluateBenchmarkTrace(benchmarkCase, trace);
    expect(result.status).toBe("failed");
    expect(result.assertionResults.find((assertion) => assertion.assertionId === "frontend-read-prd")).toMatchObject({
      required: true,
      status: "failed",
      score: 0,
    });
  });

  it("recognizes a verified logical input edge after a producer recovery task", () => {
    const trace = buildTrace();
    const originalFrontend = trace.tasks[1];
    originalFrontend.taskId = "t3";
    originalFrontend.attempts[0].taskId = "t3";
    originalFrontend.producedBindings = [];
    const reviewer: ContextTraceRunTask = {
      taskId: "t4",
      agentId: "ag_reviewer",
      title: "Reviewer",
      dependsOn: ["t3"],
      attempts: [attempt("att_review", "t4", "ag_reviewer")],
      producedBindings: [],
      consumedInputs: [{
        fromTaskId: "t3",
        outputKey: "web_app",
        artifactId: "art_recovered",
        artifactTitle: "Recovered app",
        artifactType: "web_app",
        artifactVersion: 1,
        bindingVerified: true,
        readByCurrentAttempt: true,
      }],
      evidence: [],
      verdicts: [],
      warnings: [],
    };
    trace.tasks.push(reviewer);
    const recoveryCase: AgentBenchmarkCase = {
      ...benchmarkCase,
      assertions: [{
        id: "frontend-reviewer",
        type: "dag_edge",
        fromRole: "frontend",
        toRole: "reviewer",
        outputKey: "web_app",
        required: true,
      }],
    };

    const result = evaluateBenchmarkTrace(recoveryCase, trace);
    expect(result.status).toBe("passed");
  });

  it("does not depend on assertion description wording", () => {
    const changedWording: AgentBenchmarkCase = {
      ...benchmarkCase,
      assertions: benchmarkCase.assertions.map((assertion) => ({
        ...assertion,
        description: "Arbitrary wording with no evaluator keywords.",
      })),
    };
    const original = evaluateBenchmarkTrace(benchmarkCase, buildTrace());
    const changed = evaluateBenchmarkTrace(changedWording, buildTrace());
    expect(changed.assertionResults.map((item) => item.status)).toEqual(
      original.assertionResults.map((item) => item.status),
    );
  });

  it("grades tool-level failure-before-success independently from task attempts", () => {
    const recoveryCase: AgentBenchmarkCase = {
      ...benchmarkCase,
      assertions: [{
        id: "deploy-tool-retry",
        type: "tool_retry_bound",
        role: "frontend",
        toolName: "deploy_workspace",
        minCalls: 2,
        maxCalls: 3,
        requireFailureBeforeSuccess: true,
        required: true,
      }],
    };
    const runtime = emptyRuntime();
    runtime.toolCalls = [
      {
        runId: "run_frontend",
        taskId: "r2",
        attemptId: "att_frontend",
        callId: "call_deploy_1",
        toolName: "deploy_workspace",
        args: { path: "dist" },
        status: "failed",
        result: "missing path",
        sequence: 0,
      },
      {
        runId: "run_frontend",
        taskId: "r2",
        attemptId: "att_frontend",
        callId: "call_deploy_2",
        toolName: "deploy_workspace",
        args: { path: "dist" },
        status: "succeeded",
        result: { previewPath: "/deployments/dep_1" },
        sequence: 1,
      },
    ];

    const result = evaluateBenchmarkTrace(recoveryCase, buildTrace(), { runtimeValidation: runtime });
    expect(result.status).toBe("passed");
    expect(result.assertionResults[0].references).toHaveLength(2);
  });

  it("passes an expected verifier rejection without requiring task completion", () => {
    const negativeCase: AgentBenchmarkCase = {
      ...benchmarkCase,
      assertions: [{
        id: "fake-artifact-rejected",
        type: "verification_status",
        role: "frontend",
        expected: "rejected",
        warningCode: "guessed_artifact_id",
        required: true,
      }, {
        id: "no-fake-binding",
        type: "output_binding",
        role: "frontend",
        outputKey: "web_app",
        artifactType: "web_app",
        requiredAbsent: true,
        required: true,
      }],
    };
    const trace = buildTrace();
    trace.tasks[1].attempts[0].verificationStatus = "rejected";
    trace.tasks[1].producedBindings = [];
    trace.tasks[1].warnings.push({
      code: "guessed_artifact_id",
      severity: "error",
      message: "Fake artifact id was rejected.",
    });

    const result = evaluateBenchmarkTrace(negativeCase, trace);
    expect(result.status).toBe("passed");
    expect(result.assertionResults.every((item) => item.status === "passed")).toBe(true);
  });
});

function emptyRuntime(): BenchmarkRuntimeValidation {
  return {
    collectedAt: 1,
    artifacts: [],
    builds: [],
    deployments: [],
    previews: [],
    browsers: [],
    toolRejections: [],
    injectedFaults: [],
    approvals: [],
  };
}

function buildTrace(): ContextTraceRunResponse {
  const pmAttempt = attempt("att_pm", "r1", "ag_pm");
  const frontendAttempt = attempt("att_frontend", "r2", "ag_mock_builder");
  const pmTask: ContextTraceRunTask = {
    taskId: "r1",
    agentId: "ag_pm",
    title: "PM requirements",
    dependsOn: [],
    attempts: [pmAttempt],
    producedBindings: [{
      producerTaskId: "r1",
      outputKey: "prd",
      artifactId: "art_prd",
      artifactTitle: "PRD",
      artifactType: "document",
      createdAt: 1,
    }],
    consumedInputs: [],
    evidence: [evidence("ev_prd", "artifact_created", "call_prd", "prd")],
    verdicts: [],
    warnings: [],
  };
  const frontendTask: ContextTraceRunTask = {
    taskId: "r2",
    agentId: "ag_mock_builder",
    title: "Frontend implementation",
    dependsOn: ["r1"],
    attempts: [frontendAttempt],
    producedBindings: [{
      producerTaskId: "r2",
      outputKey: "web_app",
      artifactId: "art_app",
      artifactTitle: "App",
      artifactType: "web_app",
      createdAt: 2,
    }],
    consumedInputs: [{
      fromTaskId: "r1",
      outputKey: "prd",
      artifactId: "art_prd",
      artifactTitle: "PRD",
      artifactType: "document",
      artifactVersion: 1,
      bindingVerified: true,
      readByCurrentAttempt: true,
    }],
    evidence: [
      evidence("ev_read", "artifact_read", "call_read", "art_prd"),
      evidence("ev_build", "command_executed", "call_build", "pnpm build"),
      evidence("ev_deploy", "deployment_created", "call_deploy", "web_app"),
    ],
    verdicts: [],
    warnings: [],
  };

  return {
    conductorRunId: "run_bench",
    conversationId: "conv_bench",
    planId: "plan_bench",
    tasks: [pmTask, frontendTask],
    metrics: {
      taskCount: 2,
      attemptCount: 2,
      completedTaskCount: 2,
      failedTaskCount: 0,
      verifiedInputCount: 1,
      missingRequiredInputCount: 0,
      upstreamInputReadCount: 1,
      upstreamInputUnreadCount: 0,
      contextIncludedItemCount: 1,
      contextOmittedItemCount: 0,
      contextOmittedByBudgetCount: 0,
      staleRejectedCount: 0,
      staleFactLeakageCount: 0,
      unverifiedRejectedCount: 0,
      unrelatedRejectedCount: 0,
      contextOmittedReasonCounts: {},
      evidenceCount: 4,
      toolCallCount: 4,
      failedToolCallCount: 0,
      verifiedOutputBindingCount: 2,
      rejectedOutputClaimCount: 0,
      unverifiedOutputPropagationCount: 0,
      approvalRequestCount: 0,
      jsonRepairCount: 0,
      inputTokens: 100,
      outputTokens: 20,
      modelRunCount: 2,
      verifiedTaskCount: 2,
      rejectedTaskCount: 0,
      needsReviewTaskCount: 0,
      artifactCreatedCount: 2,
      webAppOutputCount: 1,
      deploymentReadyCount: 1,
    },
  };
}

function attempt(id: string, taskId: string, agentId: string): ContextTraceAttempt {
  return {
    conversationId: "conv_bench",
    conductorRunId: "run_bench",
    planId: "plan_bench",
    taskId,
    attemptId: id,
    agentId,
    contextSnapshotId: `ctx_${id}`,
    executionStatus: "reported_complete",
    verificationStatus: "verified",
    startedAt: 1,
    finishedAt: 2,
  };
}

function evidence(
  evidenceId: string,
  type: string,
  sourceId: string,
  excerpt: string,
): ContextTraceEvidenceSummary {
  return {
    evidenceId,
    type,
    status: "valid",
    trustLevel: "verified",
    sourceKind: "tool_call",
    sourceId,
    subjectType: "artifact",
    subjectId: excerpt,
    excerpt,
    createdAt: 1,
  };
}
