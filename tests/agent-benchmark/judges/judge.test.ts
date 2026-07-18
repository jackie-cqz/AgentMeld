import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { AgentBenchmarkCase } from "@/server/context-metrics/benchmark-types";
import type { ContextTraceRunResponse } from "@/server/context-trace/context-trace-types";
import type { E2ERunResult } from "../../e2e-runner/types";
import { buildJudgeCacheKey, runCodexJudge } from "./codex-judge";
import { buildJudgePacket } from "./judge-packet-builder";
import { composeVerdict } from "./verdict-composer";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe("Codex judge", () => {
  it("exports a reproducible manual packet and strict result template", async () => {
    const reportDir = tempDir();
    const packet = buildJudgePacket(benchmarkCase(), trace(), deterministicResult());
    const execution = await runCodexJudge(benchmarkCase(), packet, { mode: "manual_codex", reportDir, cacheDir: path.join(reportDir, "cache") });
    expect(execution.status).toBe("pending");
    expect(fs.existsSync(path.join(reportDir, "judge-packet.json"))).toBe(true);
    expect(fs.existsSync(path.join(reportDir, "judge-result.template.json"))).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(reportDir, "judge-packet.json"), "utf-8")).packetHash).toBe(packet.packetHash);
  });

  it("rejects manual judge references that do not exist in the packet", async () => {
    const reportDir = tempDir();
    const packet = buildJudgePacket(benchmarkCase(), trace(), deterministicResult());
    const importPath = path.join(reportDir, "invalid-result.json");
    fs.writeFileSync(importPath, JSON.stringify(judgeResult(packet.packetHash, "artifact:not-real")), "utf-8");
    const execution = await runCodexJudge(benchmarkCase(), packet, { mode: "manual_codex", reportDir, importPath, cacheDir: path.join(reportDir, "cache") });
    expect(execution.status).toBe("failed");
    expect(execution.error).toContain("unknown evidence");
  });

  it("never allows a semantic pass to override deterministic hard-gate failure", () => {
    const deterministic = { ...deterministicResult(), status: "failed" as const };
    const verdict = composeVerdict(deterministic, {
      mode: "manual_codex", status: "completed", packetPath: "packet", resultPath: "result", packetHash: "a".repeat(64), fromCache: false, error: null,
      result: judgeResult("a".repeat(64), "task:r1"),
    }, true);
    expect(verdict.finalVerdict).toBe("failed");
    expect(verdict.reason).toContain("cannot override");
  });

  it("does not share cached results across models or rubric versions", () => {
    const base = {
      packetHash: "a".repeat(64), mode: "api" as const, model: "judge-a",
      promptVersion: "agentmeld-judge-v1", rubricVersion: "rubric-v1",
    };
    expect(buildJudgeCacheKey(base)).not.toBe(buildJudgeCacheKey({ ...base, model: "judge-b" }));
    expect(buildJudgeCacheKey(base)).not.toBe(buildJudgeCacheKey({ ...base, rubricVersion: "rubric-v2" }));
  });

  it("rejects a manual result produced with a stale prompt version", async () => {
    const reportDir = tempDir();
    const packet = buildJudgePacket(benchmarkCase(), trace(), deterministicResult());
    const importPath = path.join(reportDir, "stale-result.json");
    fs.writeFileSync(importPath, JSON.stringify({
      ...judgeResult(packet.packetHash, "task:r1"),
      promptVersion: "agentmeld-judge-v0",
    }), "utf-8");
    const execution = await runCodexJudge(benchmarkCase(), packet, {
      mode: "manual_codex", reportDir, importPath, cacheDir: path.join(reportDir, "cache"),
    });
    expect(execution.status).toBe("failed");
    expect(execution.error).toContain("promptVersion");
  });

  it("routes a low-confidence result to human review", async () => {
    const reportDir = tempDir();
    const packet = buildJudgePacket(benchmarkCase(), trace(), deterministicResult());
    const importPath = path.join(reportDir, "low-confidence-result.json");
    fs.writeFileSync(importPath, JSON.stringify({
      ...judgeResult(packet.packetHash, "task:r1"),
      confidence: 0.4,
    }), "utf-8");
    const execution = await runCodexJudge(benchmarkCase(), packet, {
      mode: "manual_codex", reportDir, importPath, cacheDir: path.join(reportDir, "cache"),
    });
    expect(execution.status).toBe("completed");
    expect(execution.result?.verdict).toBe("needs_human_review");
  });
});

function benchmarkCase(): AgentBenchmarkCase {
  return {
    schemaVersion: 1, id: "judge-case", title: "Judge case", description: "Semantic judge case", category: "collaboration", prompt: "Build app", expectedRoles: ["frontend"],
    assertions: [], limits: { maxDurationMs: 1000 }, judge: { enabled: true, requiredForPass: false }, tags: ["unit"],
  };
}

function trace(): ContextTraceRunResponse {
  return {
    conductorRunId: "run_1", conversationId: "conv_1", planId: "plan_1",
    tasks: [{ taskId: "r1", agentId: "ag_mock_builder", title: "Frontend", dependsOn: [], attempts: [{ conversationId: "conv_1", conductorRunId: "run_1", planId: "plan_1", taskId: "r1", attemptId: "att_1", agentId: "ag_mock_builder", contextSnapshotId: "ctx_1", executionStatus: "reported_complete", verificationStatus: "verified", startedAt: 1, finishedAt: 2 }], producedBindings: [], consumedInputs: [], evidence: [], verdicts: [], warnings: [] }],
    metrics: { taskCount: 1, attemptCount: 1, completedTaskCount: 1, failedTaskCount: 0, verifiedInputCount: 0, missingRequiredInputCount: 0, upstreamInputReadCount: 0, upstreamInputUnreadCount: 0, contextIncludedItemCount: 0, contextOmittedItemCount: 0, contextOmittedByBudgetCount: 0, contextOmittedReasonCounts: {}, staleRejectedCount: 0, staleFactLeakageCount: 0, unverifiedRejectedCount: 0, unrelatedRejectedCount: 0, evidenceCount: 0, toolCallCount: 0, failedToolCallCount: 0, verifiedOutputBindingCount: 0, rejectedOutputClaimCount: 0, unverifiedOutputPropagationCount: 0, approvalRequestCount: 0, jsonRepairCount: 0, inputTokens: 1, outputTokens: 1, modelRunCount: 1, verifiedTaskCount: 1, rejectedTaskCount: 0, needsReviewTaskCount: 0, artifactCreatedCount: 0, webAppOutputCount: 0, deploymentReadyCount: 0 },
  };
}

function deterministicResult(): E2ERunResult {
  return {
    fixtureId: "judge-case", runId: "run_1", startedAt: 1, finishedAt: 2, status: "passed",
    metrics: { taskCount: 1, attemptCount: 1, completedTaskCount: 1, failedTaskCount: 0, verifiedInputCount: 0, missingRequiredInputCount: 0, upstreamInputReadCount: 0, upstreamInputUnreadCount: 0, contextIncludedItemCount: 0, contextOmittedItemCount: 0, contextOmittedByBudgetCount: 0, contextOmittedReasonCounts: {}, staleRejectedCount: 0, staleFactLeakageCount: 0, unverifiedRejectedCount: 0, unrelatedRejectedCount: 0, toolCallCount: 0, failedToolCallCount: 0, toolRetryCount: 0, approvalRequestCount: 0, jsonRepairCount: 0, inputTokens: 1, outputTokens: 1, modelRunCount: 1, verifiedOutputBindingCount: 0, rejectedOutputClaimCount: 0, unverifiedOutputPropagationCount: 0, expectedRoleCount: 1, executedExpectedRoleCount: 1, expectedOutputCount: 0, verifiedExpectedOutputCount: 0, reviewerPassed: false, artifactCreatedCount: 0, webAppOutputCount: 0, deploymentReadyCount: 0 },
    assertionResults: [], artifacts: [], warnings: [],
  };
}

function judgeResult(packetHash: string, evidenceRef: string) {
  const dimensions = ["requirement_coverage", "role_specialization", "handoff_quality", "cross_artifact_consistency", "implementation_fidelity", "review_quality", "final_summary_accuracy"];
  return {
    schemaVersion: 1 as const, provider: "openai-codex-manual", model: "codex", promptVersion: "agentmeld-judge-v1", rubricVersion: "collaboration-rubric-v1", packetHash,
    dimensions: dimensions.map((dimension) => ({ dimension, score: 4 as const, reason: "Grounded reason", evidenceRefs: [evidenceRef] })),
    weightedScore: 100, verdict: "passed" as const, confidence: 0.9, summary: "Passed", createdAt: Date.now(),
  };
}

function tempDir(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agentmeld-judge-"));
  temporaryDirectories.push(directory);
  return directory;
}
