import type { AgentBenchmarkCase } from "@/server/context-metrics/benchmark-types";
import type { ContextTraceRunResponse } from "@/server/context-trace/context-trace-types";

import { createDefaultBenchmarkGraderRegistry } from "./graders/grader-registry";
import type { E2ERunMetrics, E2ERunResult } from "../e2e-runner/types";

export function evaluateBenchmarkTrace(
  benchmarkCase: AgentBenchmarkCase,
  trace: ContextTraceRunResponse,
  options: { startedAt?: number; finishedAt?: number; strategy?: string } = {},
): E2ERunResult {
  const startedAt = options.startedAt ?? Date.now();
  const finishedAt = options.finishedAt ?? Date.now();
  const registry = createDefaultBenchmarkGraderRegistry();
  const assertionResults = registry.gradeAll(benchmarkCase, trace);
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
    metrics: deriveRunMetrics(trace),
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
      return errorResult(benchmarkCase.id, runId, startedAt, `Context trace API returned ${response.status}.`, options.strategy);
    }
    const body = await response.json() as ContextTraceRunResponse | { error: string };
    if ("error" in body) return errorResult(benchmarkCase.id, runId, startedAt, body.error, options.strategy);
    return evaluateBenchmarkTrace(benchmarkCase, body, {
      startedAt,
      finishedAt: Date.now(),
      strategy: options.strategy,
    });
  } catch (error) {
    return errorResult(benchmarkCase.id, runId, startedAt, `Failed to fetch trace: ${String(error)}`, options.strategy);
  }
}

export function deriveRunMetrics(trace: ContextTraceRunResponse): E2ERunMetrics {
  const evidence = trace.tasks.flatMap((task) => task.evidence);
  const toolEvidence = evidence.filter((item) => item.sourceKind === "tool_call");
  const toolCallIds = new Set(toolEvidence.map((item) => item.sourceId));
  const failedToolCallIds = new Set(
    toolEvidence.filter((item) => item.status === "invalid").map((item) => item.sourceId),
  );
  const warningCodes = trace.tasks.flatMap((task) => task.warnings.map((warning) => warning.code));
  const webAppOutputCount = trace.tasks.reduce(
    (total, task) => total + task.producedBindings.filter((binding) => binding.artifactType === "web_app").length,
    0,
  );

  return {
    taskCount: trace.metrics.taskCount,
    attemptCount: trace.metrics.attemptCount,
    completedTaskCount: trace.metrics.completedTaskCount,
    failedTaskCount: trace.metrics.failedTaskCount,
    verifiedInputCount: trace.metrics.verifiedInputCount,
    missingRequiredInputCount: trace.metrics.missingRequiredInputCount,
    upstreamInputReadCount: trace.metrics.upstreamInputReadCount,
    upstreamInputUnreadCount: trace.metrics.upstreamInputUnreadCount,
    toolCallCount: toolCallIds.size,
    failedToolCallCount: failedToolCallIds.size,
    verifiedOutputBindingCount: trace.metrics.verifiedOutputBindingCount,
    rejectedOutputClaimCount: warningCodes.filter((code) =>
      code === "unverified_output_not_propagated" || code === "guessed_artifact_id" || code === "tool_claim_without_evidence"
    ).length,
    artifactCreatedCount: trace.metrics.artifactCreatedCount,
    webAppOutputCount,
    deploymentReadyCount: trace.metrics.deploymentReadyCount,
  };
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
    toolCallCount: 0,
    failedToolCallCount: 0,
    verifiedOutputBindingCount: 0,
    rejectedOutputClaimCount: 0,
    artifactCreatedCount: 0,
    webAppOutputCount: 0,
    deploymentReadyCount: 0,
  };
}

function errorResult(
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
