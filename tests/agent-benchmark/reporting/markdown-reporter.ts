import type { AgentBenchmarkReport } from "@/server/context-metrics/benchmark-types";
import type { BenchmarkTrialReport } from "../runtime/benchmark-runner";
import type { BenchmarkAggregateReport } from "./metrics-aggregator";

export function buildMarkdownReport(
  report: AgentBenchmarkReport,
  aggregate: BenchmarkAggregateReport,
  trials: BenchmarkTrialReport[],
): string {
  const lines = [
    "# AgentMeld Collaboration Benchmark",
    "",
    `- Generated: ${new Date(report.generatedAt).toISOString()}`,
    `- Strategy: ${report.strategy}`,
    `- Cases: ${report.totalCases}`,
    `- Trials: ${aggregate.totalTrials}`,
    `- Trial success rate: ${(aggregate.overallTrialSuccessRate * 100).toFixed(1)}%`,
    `- Input / output tokens: ${aggregate.totalInputTokens} / ${aggregate.totalOutputTokens}`,
    `- Task / tool retries: ${aggregate.totalTaskRetries} / ${aggregate.totalToolRetries}`,
    `- Blocked / propagated unverified outputs: ${aggregate.totalBlockedOutputs} / ${aggregate.totalPropagatedOutputs}`,
    "",
    "## Verdicts",
    "",
    "| Case | Trial | Deterministic | Semantic | Final | Task retries | Tool retries | Blocked / propagated | Tool failure | Duration |",
    "|---|---:|---|---|---|---:|---:|---:|---:|---:|",
  ];
  for (const trial of trials) {
    const metrics = trial.result.metrics;
    const taskRetries = Math.max(0, metrics.attemptCount - metrics.taskCount);
    const toolFailureRate = metrics.toolCallCount > 0
      ? `${(metrics.failedToolCallCount / metrics.toolCallCount * 100).toFixed(1)}%`
      : "0.0%";
    lines.push(`| ${escapeCell(trial.caseId)} | ${trial.trialIndex} | ${trial.verdict.deterministicVerdict} | ${trial.verdict.semanticVerdict} | ${trial.verdict.finalVerdict} | ${taskRetries} | ${metrics.toolRetryCount} | ${metrics.rejectedOutputClaimCount} / ${metrics.unverifiedOutputPropagationCount} | ${toolFailureRate} | ${trial.durationMs} ms |`);
  }
  lines.push("", "## Failed Assertions", "");
  const failures = trials.flatMap((trial) => trial.result.assertionResults
    .filter((assertion) => assertion.status !== "passed")
    .map((assertion) => ({ trial, assertion })));
  if (!failures.length) lines.push("No assertion failures.");
  for (const failure of failures) {
    lines.push(`- **${failure.trial.caseId} / trial ${failure.trial.trialIndex} / ${failure.assertion.assertionId}**: ${failure.assertion.reason}`);
  }
  lines.push("", "## Semantic Judge", "");
  const judged = trials.filter((trial) => trial.judge?.result);
  if (!judged.length) lines.push("No completed semantic judge results.");
  for (const trial of judged) {
    lines.push(`### ${trial.caseId} / trial ${trial.trialIndex}`);
    lines.push(`Score: ${trial.judge!.result!.weightedScore}/100; verdict: ${trial.judge!.result!.verdict}; confidence: ${trial.judge!.result!.confidence}.`);
    for (const dimension of trial.judge!.result!.dimensions) {
      lines.push(`- ${dimension.dimension}: ${dimension.score}/4 — ${dimension.reason} (${dimension.evidenceRefs.join(", ")})`);
    }
    lines.push("");
  }
  return `${lines.join("\n")}\n`;
}

function escapeCell(value: string): string {
  return value.replaceAll("|", "\\|").replaceAll("\n", " ");
}
