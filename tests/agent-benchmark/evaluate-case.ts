import type { AgentBenchmarkCase, AssertionResult, BenchmarkRole, BenchmarkRuntimeValidation } from "@/server/context-metrics/benchmark-types";
import type { ContextTraceRunResponse, ContextTraceRunTask } from "@/server/context-trace/context-trace-types";

import { createDefaultBenchmarkGraderRegistry } from "./graders/grader-registry";
import { findTasksByRole } from "./graders/role-utils";
import type { E2ERunMetrics, E2ERunResult } from "../e2e-runner/types";

export function evaluateBenchmarkTrace(
  benchmarkCase: AgentBenchmarkCase,
  trace: ContextTraceRunResponse,
  options: { startedAt?: number; finishedAt?: number; strategy?: string; runtimeValidation?: BenchmarkRuntimeValidation } = {},
): E2ERunResult {
  const startedAt = options.startedAt ?? Date.now();
  const finishedAt = options.finishedAt ?? Date.now();
  const registry = createDefaultBenchmarkGraderRegistry();
  const assertionResults = registry.gradeAll(benchmarkCase, trace, options.runtimeValidation);
  const requiredFailures = assertionResults.filter(
    (result) => result.required && result.status !== "passed",
  );
  const optionalFailures = assertionResults.filter(
    (result) => !result.required && result.status === "failed",
  );

  const artifacts = trace.tasks.flatMap((task) =>
    task.producedBindings.map((binding) => ({
      outputKey: binding.outputKey,
      artifactId: binding.artifactId,
      type: binding.artifactType,
      title: binding.artifactTitle,
    }))
  );
  const traceWarnings = trace.tasks.flatMap((task) => task.warnings.map((warning) => warning.message));
  const warnings = [
    ...new Set([
      ...traceWarnings,
      ...optionalFailures.map((result) => `Optional assertion failed: ${result.assertionId} — ${result.reason}`),
    ]),
  ];

  return {
    fixtureId: benchmarkCase.id,
    runId: trace.conductorRunId,
    startedAt,
    finishedAt,
    status: requiredFailures.length === 0 ? "passed" : "failed",
    strategy: options.strategy,
    metrics: deriveRunMetrics(trace, benchmarkCase, assertionResults, options.runtimeValidation),
    assertionResults,
    artifacts,
    warnings,
  };
}

export async function fetchAndEvaluateBenchmarkRun(
  runId: string,
  benchmarkCase: AgentBenchmarkCase,
  options: { apiBase?: string; strategy?: string } = {},
): Promise<E2ERunResult> {
  const startedAt = Date.now();
  const apiBase = options.apiBase ?? process.env.AGENTMELD_API_BASE ?? "http://localhost:3000";
  try {
    const response = await fetch(`${apiBase}/api/context-trace/run/${runId}`);
    if (!response.ok) {
      return createErrorRunResult(benchmarkCase.id, runId, startedAt, `Context trace API returned ${response.status}.`, options.strategy);
    }
    const body = await response.json() as ContextTraceRunResponse | { error: string };
    if ("error" in body) return createErrorRunResult(benchmarkCase.id, runId, startedAt, body.error, options.strategy);
    return evaluateBenchmarkTrace(benchmarkCase, body, {
      startedAt,
      finishedAt: Date.now(),
      strategy: options.strategy,
    });
  } catch (error) {
    return createErrorRunResult(benchmarkCase.id, runId, startedAt, `Failed to fetch trace: ${String(error)}`, options.strategy);
  }
}

export function deriveRunMetrics(
  trace: ContextTraceRunResponse,
  benchmarkCase?: AgentBenchmarkCase,
  assertionResults: AssertionResult[] = [],
  runtimeValidation?: BenchmarkRuntimeValidation,
): E2ERunMetrics {
  const warningCodes = trace.tasks.flatMap((task) => task.warnings.map((warning) => warning.code));
  const expectedRoles = benchmarkCase?.expectedRoles ?? [];
  const executedExpectedRoleCount = expectedRoles.filter((role) => roleExecuted(trace, role)).length;
  const expectedOutputs = benchmarkCase?.assertions.filter((assertion) => assertion.type === "output_binding") ?? [];
  const verifiedExpectedOutputCount = expectedOutputs.filter((assertion) =>
    assertionResults.some((result) => result.assertionId === assertion.id && result.status === "passed")
  ).length;
  const reviewerPassed = reviewerTasksPassed(findTasksByRole(trace.tasks, "reviewer"));
  const falseCompletionWarnings = warningCodes.filter((code) =>
    code === "unverified_output_not_propagated" || code === "guessed_artifact_id" || code === "tool_claim_without_evidence"
  ).length;

  return {
    taskCount: trace.metrics.taskCount,
    attemptCount: trace.metrics.attemptCount,
    completedTaskCount: trace.metrics.completedTaskCount,
    failedTaskCount: trace.metrics.failedTaskCount,
    verifiedInputCount: trace.metrics.verifiedInputCount,
    missingRequiredInputCount: trace.metrics.missingRequiredInputCount,
    upstreamInputReadCount: trace.metrics.upstreamInputReadCount,
    upstreamInputUnreadCount: trace.metrics.upstreamInputUnreadCount,
    contextIncludedItemCount: trace.metrics.contextIncludedItemCount,
    contextOmittedItemCount: trace.metrics.contextOmittedItemCount,
    contextOmittedByBudgetCount: trace.metrics.contextOmittedByBudgetCount,
    contextOmittedReasonCounts: trace.metrics.contextOmittedReasonCounts,
    staleRejectedCount: trace.metrics.staleRejectedCount,
    staleFactLeakageCount: trace.metrics.staleFactLeakageCount,
    unverifiedRejectedCount: trace.metrics.unverifiedRejectedCount,
    unrelatedRejectedCount: trace.metrics.unrelatedRejectedCount,
    toolCallCount: trace.metrics.toolCallCount,
    failedToolCallCount: trace.metrics.failedToolCallCount,
    toolRetryCount: countToolRetries(runtimeValidation?.toolCalls ?? []),
    approvalRequestCount: trace.metrics.approvalRequestCount,
    jsonRepairCount: trace.metrics.jsonRepairCount,
    inputTokens: trace.metrics.inputTokens,
    outputTokens: trace.metrics.outputTokens,
    modelRunCount: trace.metrics.modelRunCount,
    verifiedOutputBindingCount: trace.metrics.verifiedOutputBindingCount,
    rejectedOutputClaimCount: Math.max(trace.metrics.rejectedOutputClaimCount, falseCompletionWarnings),
    unverifiedOutputPropagationCount: trace.metrics.unverifiedOutputPropagationCount,
    expectedRoleCount: expectedRoles.length,
    executedExpectedRoleCount,
    expectedOutputCount: expectedOutputs.length,
    verifiedExpectedOutputCount,
    reviewerPassed,
    artifactCreatedCount: trace.metrics.artifactCreatedCount,
    webAppOutputCount: trace.metrics.webAppOutputCount,
    deploymentReadyCount: trace.metrics.deploymentReadyCount,
  };
}

export function reviewerTasksPassed(reviewerTasks: ContextTraceRunTask[]): boolean {
  return reviewerTasks.length > 0 && reviewerTasks.every((task) => {
    const latest = task.attempts.at(-1);
    return latest?.verificationStatus === "verified" && task.verdicts.every(
      (verdict) => verdict.status === "passed" || verdict.status === "missing"
    );
  });
}

function roleExecuted(trace: ContextTraceRunResponse, role: BenchmarkRole): boolean {
  if (role === "conductor") return Boolean(trace.conductorRunId);
  return findTasksByRole(trace.tasks, role).some((task) => task.attempts.length > 0);
}

export function emptyRunMetrics(): E2ERunMetrics {
  return {
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
    toolCallCount: 0,
    failedToolCallCount: 0,
    toolRetryCount: 0,
    approvalRequestCount: 0,
    jsonRepairCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    modelRunCount: 0,
    verifiedOutputBindingCount: 0,
    rejectedOutputClaimCount: 0,
    unverifiedOutputPropagationCount: 0,
    expectedRoleCount: 0,
    executedExpectedRoleCount: 0,
    expectedOutputCount: 0,
    verifiedExpectedOutputCount: 0,
    reviewerPassed: false,
    artifactCreatedCount: 0,
    webAppOutputCount: 0,
    deploymentReadyCount: 0,
  };
}

export function countToolRetries(
  toolCalls: NonNullable<BenchmarkRuntimeValidation["toolCalls"]>,
): number {
  const counts = new Map<string, number>();
  for (const call of toolCalls) {
    const key = [
      call.runId,
      call.taskId ?? "",
      call.attemptId ?? "",
      call.toolName,
      stableJson(call.args),
    ].join("\u0000");
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.values()].reduce((sum, count) => sum + Math.max(0, count - 1), 0);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}

export function createErrorRunResult(
  fixtureId: string,
  runId: string,
  startedAt: number,
  error: string,
  strategy?: string,
): E2ERunResult {
  return {
    fixtureId,
    runId,
    startedAt,
    finishedAt: Date.now(),
    status: "error",
    strategy,
    metrics: emptyRunMetrics(),
    assertionResults: [],
    artifacts: [],
    warnings: [],
    error,
  };
}
