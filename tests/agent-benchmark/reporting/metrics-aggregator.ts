import type { BenchmarkTrialReport } from "../runtime/benchmark-runner";
import { mean, percentile, standardDeviation, wilsonInterval } from "./statistics";

export interface BenchmarkCaseAggregate {
  caseId: string;
  trialCount: number;
  passAt1: number;
  trialSuccessRate: number;
  allTrialsPass: boolean;
  successWilson95: { low: number; high: number };
  durationMs: { mean: number; standardDeviation: number; p50: number; p95: number };
  inputTokens: { mean: number; total: number };
  outputTokens: { mean: number; total: number };
  toolCalls: { mean: number; total: number };
  taskRetries: { mean: number; total: number };
  toolRetries: { mean: number; total: number };
  blockedOutputs: number;
  propagatedOutputs: number;
  estimatedJudgeCostUsd: number;
  failureReasons: Record<string, number>;
}

export interface BenchmarkAggregateReport {
  generatedAt: number;
  totalTrials: number;
  cases: BenchmarkCaseAggregate[];
  overallTrialSuccessRate: number;
  totalDurationMs: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalToolCalls: number;
  totalTaskRetries: number;
  totalToolRetries: number;
  totalBlockedOutputs: number;
  totalPropagatedOutputs: number;
  totalEstimatedJudgeCostUsd: number;
}

export function aggregateTrials(trials: BenchmarkTrialReport[]): BenchmarkAggregateReport {
  const grouped = new Map<string, BenchmarkTrialReport[]>();
  for (const trial of trials) grouped.set(trial.caseId, [...(grouped.get(trial.caseId) ?? []), trial]);
  const cases = [...grouped.entries()].map(([caseId, caseTrials]) => aggregateCase(caseId, caseTrials));
  const passed = trials.filter((trial) => trial.verdict.finalVerdict === "passed").length;
  return {
    generatedAt: Date.now(),
    totalTrials: trials.length,
    cases,
    overallTrialSuccessRate: trials.length ? passed / trials.length : 0,
    totalDurationMs: trials.reduce((sum, trial) => sum + trial.durationMs, 0),
    totalInputTokens: trials.reduce((sum, trial) => sum + trial.result.metrics.inputTokens, 0),
    totalOutputTokens: trials.reduce((sum, trial) => sum + trial.result.metrics.outputTokens, 0),
    totalToolCalls: trials.reduce((sum, trial) => sum + trial.result.metrics.toolCallCount, 0),
    totalTaskRetries: trials.reduce(
      (sum, trial) => sum + Math.max(0, trial.result.metrics.attemptCount - trial.result.metrics.taskCount),
      0,
    ),
    totalToolRetries: trials.reduce((sum, trial) => sum + trial.result.metrics.toolRetryCount, 0),
    totalBlockedOutputs: trials.reduce((sum, trial) => sum + trial.result.metrics.rejectedOutputClaimCount, 0),
    totalPropagatedOutputs: trials.reduce((sum, trial) => sum + trial.result.metrics.unverifiedOutputPropagationCount, 0),
    totalEstimatedJudgeCostUsd: trials.reduce((sum, trial) => sum + (trial.judge?.result?.estimatedCostUsd ?? 0), 0),
  };
}

function aggregateCase(caseId: string, trials: BenchmarkTrialReport[]): BenchmarkCaseAggregate {
  const passFlags = trials.map((trial) => trial.verdict.finalVerdict === "passed");
  const successes = passFlags.filter(Boolean).length;
  const durations = trials.map((trial) => trial.durationMs);
  const inputTokens = trials.map((trial) => trial.result.metrics.inputTokens);
  const outputTokens = trials.map((trial) => trial.result.metrics.outputTokens);
  const toolCalls = trials.map((trial) => trial.result.metrics.toolCallCount);
  const taskRetries = trials.map((trial) => Math.max(0, trial.result.metrics.attemptCount - trial.result.metrics.taskCount));
  const toolRetries = trials.map((trial) => trial.result.metrics.toolRetryCount);
  const failureReasons: Record<string, number> = {};
  for (const trial of trials) {
    if (trial.verdict.finalVerdict === "passed") continue;
    const reasons = [
      ...trial.result.assertionResults.filter((result) => result.required && result.status !== "passed").map((result) => `${result.type}:${result.assertionId}`),
      ...(trial.result.error ? [`runtime:${trial.result.error}`] : []),
      ...(trial.verdict.finalVerdict === "blocked" ? [`blocked:${trial.verdict.reason}`] : []),
    ];
    for (const reason of reasons.length ? reasons : [trial.verdict.finalVerdict]) failureReasons[reason] = (failureReasons[reason] ?? 0) + 1;
  }
  return {
    caseId,
    trialCount: trials.length,
    passAt1: passFlags[0] ? 1 : 0,
    trialSuccessRate: trials.length ? successes / trials.length : 0,
    allTrialsPass: trials.length > 0 && successes === trials.length,
    successWilson95: wilsonInterval(successes, trials.length),
    durationMs: { mean: mean(durations), standardDeviation: standardDeviation(durations), p50: percentile(durations, 50), p95: percentile(durations, 95) },
    inputTokens: { mean: mean(inputTokens), total: inputTokens.reduce((sum, value) => sum + value, 0) },
    outputTokens: { mean: mean(outputTokens), total: outputTokens.reduce((sum, value) => sum + value, 0) },
    toolCalls: { mean: mean(toolCalls), total: toolCalls.reduce((sum, value) => sum + value, 0) },
    taskRetries: { mean: mean(taskRetries), total: taskRetries.reduce((sum, value) => sum + value, 0) },
    toolRetries: { mean: mean(toolRetries), total: toolRetries.reduce((sum, value) => sum + value, 0) },
    blockedOutputs: trials.reduce((sum, trial) => sum + trial.result.metrics.rejectedOutputClaimCount, 0),
    propagatedOutputs: trials.reduce((sum, trial) => sum + trial.result.metrics.unverifiedOutputPropagationCount, 0),
    estimatedJudgeCostUsd: trials.reduce((sum, trial) => sum + (trial.judge?.result?.estimatedCostUsd ?? 0), 0),
    failureReasons,
  };
}
