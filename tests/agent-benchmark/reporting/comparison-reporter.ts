import type { BenchmarkTrialReport } from "../runtime/benchmark-runner";
import { aggregateTrials, type BenchmarkAggregateReport } from "./metrics-aggregator";

export interface AutomaticStrategyComparisonReport {
  generatedAt: number;
  baselineStrategy: string;
  candidateStrategy: string;
  baseline: BenchmarkAggregateReport;
  candidate: BenchmarkAggregateReport;
  deltas: {
    successRate: number;
    upstreamArtifactReadRate: number;
    staleFactLeakageRate: number;
    unverifiedPropagationRate: number;
    meanInputTokens: number;
    meanRetries: number;
    toolFailureRate: number;
    meanDurationMs: number;
  };
  tradeoffs: string[];
}

export function compareTrialStrategies(
  trials: BenchmarkTrialReport[],
  baselineStrategy: string,
  candidateStrategy: string,
): AutomaticStrategyComparisonReport {
  const baselineTrials = trials.filter((trial) => trial.result.strategy === baselineStrategy);
  const candidateTrials = trials.filter((trial) => trial.result.strategy === candidateStrategy);
  if (!baselineTrials.length || !candidateTrials.length) throw new Error("Both baseline and candidate trials are required for comparison.");
  const baseline = aggregateTrials(baselineTrials);
  const candidate = aggregateTrials(candidateTrials);
  const b = summarize(baselineTrials);
  const c = summarize(candidateTrials);
  const deltas = {
    successRate: c.successRate - b.successRate,
    upstreamArtifactReadRate: c.readRate - b.readRate,
    staleFactLeakageRate: c.staleLeakRate - b.staleLeakRate,
    unverifiedPropagationRate: c.unverifiedRate - b.unverifiedRate,
    meanInputTokens: c.inputTokens - b.inputTokens,
    meanRetries: c.retries - b.retries,
    toolFailureRate: c.toolFailureRate - b.toolFailureRate,
    meanDurationMs: c.duration - b.duration,
  };
  const tradeoffs: string[] = [];
  if (deltas.successRate > 0 && deltas.meanInputTokens > 0) tradeoffs.push(`Candidate improves success by ${(deltas.successRate * 100).toFixed(1)}pp while adding ${Math.round(deltas.meanInputTokens)} mean input tokens.`);
  if (deltas.successRate <= 0 && deltas.meanInputTokens > 0) tradeoffs.push("Candidate uses more input tokens without improving trial success rate.");
  if (deltas.toolFailureRate > 0) tradeoffs.push(`Candidate tool failure rate is ${(deltas.toolFailureRate * 100).toFixed(1)}pp higher.`);
  return { generatedAt: Date.now(), baselineStrategy, candidateStrategy, baseline, candidate, deltas, tradeoffs };
}

function summarize(trials: BenchmarkTrialReport[]) {
  const sum = (selector: (trial: BenchmarkTrialReport) => number) => trials.reduce((total, trial) => total + selector(trial), 0);
  const totalVerified = sum((trial) => trial.result.metrics.verifiedInputCount);
  const totalTools = sum((trial) => trial.result.metrics.toolCallCount);
  const totalContextItems = sum((trial) => trial.result.metrics.contextIncludedItemCount);
  const totalBindings = sum((trial) => trial.result.metrics.verifiedOutputBindingCount);
  return {
    successRate: trials.filter((trial) => trial.verdict.finalVerdict === "passed").length / trials.length,
    readRate: totalVerified ? sum((trial) => trial.result.metrics.upstreamInputReadCount) / totalVerified : 0,
    staleLeakRate: totalContextItems ? sum((trial) => trial.result.metrics.staleFactLeakageCount) / totalContextItems : 0,
    unverifiedRate: totalBindings ? sum((trial) => trial.result.metrics.unverifiedOutputPropagationCount) / totalBindings : 0,
    inputTokens: sum((trial) => trial.result.metrics.inputTokens) / trials.length,
    retries: sum((trial) => Math.max(0, trial.result.metrics.attemptCount - trial.result.metrics.taskCount)) / trials.length,
    toolFailureRate: totalTools ? sum((trial) => trial.result.metrics.failedToolCallCount) / totalTools : 0,
    duration: sum((trial) => trial.durationMs) / trials.length,
  };
}
