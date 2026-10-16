import { describe, expect, it } from "vitest";

import type {
  AgentBenchmarkCase,
  BenchmarkConsultationValidation,
  BenchmarkRuntimeValidation,
} from "@/server/context-metrics/benchmark-types";
import type { ContextTraceRunResponse } from "@/server/context-trace/context-trace-types";

import { evaluateBenchmarkTrace } from "../evaluate-case";

const benchmarkCase: AgentBenchmarkCase = {
  schemaVersion: 1,
  id: "peer-consultation-unit",
  title: "Peer consultation",
  description: "Verifies the consulted reply and the peer lifecycle.",
  category: "context_handoff",
  prompt: "Consult a peer, then ship the page.",
  expectedRoles: ["ui", "frontend"],
  assertions: [
    { id: "consulted", type: "tool_succeeded", toolName: "consult_agent", role: "frontend", required: true },
    { id: "reflected", type: "consultation_reflected", role: "frontend", outputKey: "web_app", artifactType: "web_app", answerPattern: "MELLOW-[0-9]{4}", required: true },
    { id: "lifecycle", type: "consultation_lifecycle", role: "frontend", requireReplied: true, requirePeerTornDown: true, requireLeaseRestored: true, requireReplayBounded: true, requireNoExpired: true, required: true },
  ],
  limits: { maxDurationMs: 1000 },
  tags: ["unit"],
};

describe("peer consultation graders", () => {
  it("passes when the artifact reflects the peer reply and the lease was restored", () => {
    const result = evaluateBenchmarkTrace(benchmarkCase, trace(), { runtimeValidation: validation() });
    expect(result.status).toBe("passed");
    expect(result.assertionResults.map((item) => item.status)).toEqual(["passed", "passed", "passed"]);
  });

  it("fails when the artifact contains a guessed codename instead of the peer's reply", () => {
    const runtimeValidation = validation();
    runtimeValidation.artifacts[0] = {
      ...runtimeValidation.artifacts[0],
      contentText: JSON.stringify({ files: { "index.html": "<h1>MELLOW-0001</h1>" } }),
    };
    const result = evaluateBenchmarkTrace(benchmarkCase, trace(), { runtimeValidation });
    expect(result.status).toBe("failed");
    expect(result.assertionResults.find((item) => item.assertionId === "reflected")?.reason)
      .toContain("no token matching");
  });

  it("fails when the peer run was never torn down", () => {
    const runtimeValidation = validation();
    runtimeValidation.consultations![0] = { ...runtimeValidation.consultations![0], peerRunStatus: "running" };
    const result = evaluateBenchmarkTrace(benchmarkCase, trace(), { runtimeValidation });
    expect(result.status).toBe("failed");
    expect(result.assertionResults.find((item) => item.assertionId === "lifecycle")?.reason)
      .toContain("instead of complete");
  });

  it("fails when the workspace lease was poisoned by an unconfirmed teardown", () => {
    const runtimeValidation = validation();
    runtimeValidation.workspaceLease = { workspaceKey: "/w", held: false, poisoned: true, childPid: 42 };
    const result = evaluateBenchmarkTrace(benchmarkCase, trace(), { runtimeValidation });
    expect(result.status).toBe("failed");
    expect(result.assertionResults.find((item) => item.assertionId === "lifecycle")?.reason)
      .toContain("poisoned");
  });

  it("fails when a replay created a second peer run for the same request key", () => {
    const runtimeValidation = validation();
    const duplicate = { ...runtimeValidation.consultations![0], id: "consult_2", targetRunId: "run_peer_2" };
    runtimeValidation.consultations = [...runtimeValidation.consultations!, duplicate];
    const result = evaluateBenchmarkTrace(benchmarkCase, trace(), { runtimeValidation });
    expect(result.status).toBe("failed");
    expect(result.assertionResults.find((item) => item.assertionId === "lifecycle")?.reason)
      .toContain("replayed");
  });

  it("fails when no replied consultation was recorded", () => {
    const runtimeValidation = validation();
    runtimeValidation.consultations = [];
    const result = evaluateBenchmarkTrace(benchmarkCase, trace(), { runtimeValidation });
    expect(result.status).toBe("failed");
    expect(result.assertionResults.find((item) => item.assertionId === "reflected")?.reason)
      .toContain("no replied peer consultation");
  });
});

function consultation(overrides: Partial<BenchmarkConsultationValidation> = {}): BenchmarkConsultationValidation {
  return {
    id: "consult_1",
    sourceRunId: "run_frontend",
    sourceAgentId: "ag_mock_builder",
    sourceRole: "frontend",
    targetAgentId: "ag_designer",
    targetRunId: "run_peer_1",
    requestKey: "release-codename",
    status: "replied",
    answer: "Use MELLOW-7741 for the release title.",
    peerRunStatus: "complete",
    createdAt: 1,
    updatedAt: 2,
    expiresAt: 120_001,
    ...overrides,
  };
}

function validation(): BenchmarkRuntimeValidation {
  return {
    collectedAt: 10,
    artifacts: [{
      taskId: "t1",
      outputKey: "web_app",
      artifactId: "art_app",
      artifactType: "web_app",
      title: "Landing",
      contentBytes: 400,
      contentText: JSON.stringify({ files: { "index.html": "<h1 data-testid=\"release-title\">MELLOW-7741</h1>" } }),
      files: ["index.html"],
      valid: true,
      errors: [],
    }],
    builds: [],
    deployments: [{
      taskId: "t1",
      outputKey: "web_app",
      artifactId: "art_app",
      evidenceId: "ev_deploy",
      toolCallId: "call_deploy",
      previewPath: "/deployments/dep_1",
      previewUrl: "http://127.0.0.1/deployments/dep_1",
      ready: true,
    }],
    previews: [],
    browsers: [],
    toolRejections: [],
    injectedFaults: [],
    approvals: [],
    consultations: [consultation()],
    workspaceLease: { workspaceKey: "/w", held: false, poisoned: false, childPid: null },
  };
}

function trace(): ContextTraceRunResponse {
  return {
    conductorRunId: "run_conductor",
    conversationId: "conv_1",
    planId: "plan_1",
    tasks: [{
      taskId: "t1",
      agentId: "ag_mock_builder",
      title: "Frontend implementation",
      dependsOn: [],
      attempts: [{
        conversationId: "conv_1",
        conductorRunId: "run_conductor",
        planId: "plan_1",
        taskId: "t1",
        attemptId: "att_1",
        agentId: "ag_mock_builder",
        contextSnapshotId: "ctx_1",
        executionStatus: "reported_complete",
        verificationStatus: "verified",
        startedAt: 1,
        finishedAt: 2,
      }],
      producedBindings: [{
        producerTaskId: "t1",
        outputKey: "web_app",
        artifactId: "art_app",
        artifactTitle: "Landing",
        artifactType: "web_app",
        createdAt: 2,
      }],
      consumedInputs: [],
      evidence: [{
        evidenceId: "ev_consult",
        type: "agent_consulted",
        status: "valid",
        trustLevel: "verified",
        sourceKind: "tool_call",
        sourceId: "call_consult",
        subjectType: "agent",
        subjectId: "ag_designer",
        excerpt: "",
        createdAt: 2,
      }],
      verdicts: [],
      warnings: [],
    }],
    metrics: {
      taskCount: 1, attemptCount: 1, completedTaskCount: 1, failedTaskCount: 0,
      verifiedInputCount: 0, missingRequiredInputCount: 0, upstreamInputReadCount: 0, upstreamInputUnreadCount: 0,
      contextIncludedItemCount: 0, contextOmittedItemCount: 0, contextOmittedByBudgetCount: 0, contextOmittedReasonCounts: {},
      staleRejectedCount: 0, staleFactLeakageCount: 0, unverifiedRejectedCount: 0, unrelatedRejectedCount: 0, evidenceCount: 1,
      toolCallCount: 2, failedToolCallCount: 0, verifiedOutputBindingCount: 1, rejectedOutputClaimCount: 0, unverifiedOutputPropagationCount: 0,
      approvalRequestCount: 0, jsonRepairCount: 0, inputTokens: 10, outputTokens: 5, modelRunCount: 1,
      verifiedTaskCount: 1, rejectedTaskCount: 0, needsReviewTaskCount: 0,
      artifactCreatedCount: 1, webAppOutputCount: 1, deploymentReadyCount: 1,
    },
  };
}
