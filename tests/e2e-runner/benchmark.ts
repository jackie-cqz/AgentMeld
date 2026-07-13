#!/usr/bin/env npx tsx

import * as path from "node:path";

import type {
  AgentBenchmarkMetrics,
  AgentBenchmarkReport,
} from "@/server/context-metrics/benchmark-types";
import type { ContextStrategyName } from "@/server/context-policy/strategy-registry";

import { fetchAndEvaluateBenchmarkRun } from "../agent-benchmark/evaluate-case";
import { loadBenchmarkCases } from "../agent-benchmark/schemas/benchmark-case";
import type {
  E2ERunResult,
  StrategyComparisonEntry,
  StrategyComparisonReport,
} from "./types";

const FIXTURES_DIR = path.join(__dirname, "..", "e2e-fixtures");

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const runArgIdx = args.indexOf("--run");
  const strategyArgIdx = args.indexOf("--strategy");
  const compareIdx = args.indexOf("--compare");
  const allIdx = args.indexOf("--all");

  let cases;
  try {
    cases = loadBenchmarkCases(FIXTURES_DIR);
  } catch (error) {
    console.error(String(error));
    process.exitCode = 1;
    return;
  }

  if (allIdx >= 0 && runArgIdx < 0) {
    console.log(JSON.stringify({
      generatedAt: Date.now(),
      totalFixtures: cases.length,
      fixtures: cases.map((benchmarkCase) => ({
        id: benchmarkCase.id,
        title: benchmarkCase.title,
        category: benchmarkCase.category,
        expectedRoles: benchmarkCase.expectedRoles,
        assertions: benchmarkCase.assertions.map((assertion) => ({
          id: assertion.id,
          type: assertion.type,
          required: assertion.required,
        })),
      })),
      usage: {
        single: "pnpm agent:bench --run <runId> --fixture <fixtureId>",
        evaluateAll: "pnpm agent:bench --run <id1,id2,...> --all",
        compare: "pnpm agent:bench --compare <baselineRunIds> <candidateRunIds>",
      },
    }, null, 2));
    return;
  }

  if (compareIdx >= 0) {
    const baselineRuns = args[compareIdx + 1];
    const candidateRuns = args[compareIdx + 2];
    if (!baselineRuns || !candidateRuns) {
      console.error("Usage: --compare <baselineRunIds> <candidateRunIds>");
      process.exitCode = 1;
      return;
    }
    const report = await generateComparison(baselineRuns, candidateRuns, cases);
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  if (runArgIdx >= 0) {
    const runIds = args[runArgIdx + 1]?.split(",").filter(Boolean) ?? [];
    if (runIds.length === 0) {
      console.error("Usage: --run <runId1,runId2,...> [--fixture <fixtureId>] [--strategy <name>]");
      process.exitCode = 1;
      return;
    }
    const fixtureArgIdx = args.indexOf("--fixture");
    const requestedFixture = fixtureArgIdx >= 0 ? args[fixtureArgIdx + 1] : undefined;
    const selectedCases = requestedFixture
      ? cases.filter((benchmarkCase) => benchmarkCase.id === requestedFixture)
      : cases;
    if (selectedCases.length === 0) {
      console.error(`Unknown fixture: ${requestedFixture}`);
      process.exitCode = 1;
      return;
    }
    if (runIds.length < selectedCases.length) {
      console.error(`Expected ${selectedCases.length} run id(s), received ${runIds.length}.`);
      process.exitCode = 1;
      return;
    }

    const strategy = (args[strategyArgIdx + 1] ?? "evidence_aware_context") as ContextStrategyName;
    const results: E2ERunResult[] = [];
    for (let index = 0; index < selectedCases.length; index++) {
      results.push(await fetchAndEvaluateBenchmarkRun(runIds[index], selectedCases[index], { strategy }));
    }
    const report = buildBenchmarkReport(results, strategy);
    console.log(JSON.stringify(report, null, 2));
    if (results.some((result) => result.status !== "passed")) process.exitCode = 1;
    return;
  }

  console.error("Usage: pnpm agent:bench --all | --run <runIds> [--fixture <id>] | --compare <baseline> <candidate>");
  process.exitCode = 1;
}

function buildBenchmarkReport(results: E2ERunResult[], strategy: string): AgentBenchmarkReport {
  const cases: AgentBenchmarkMetrics[] = results.map((result) => {
    const durationMs = result.finishedAt - result.startedAt;
    const roleResults = result.assertionResults.filter((item) => item.type === "role_executed");
    const outputResults = result.assertionResults.filter((item) => item.type === "output_binding");
    const edgeResults = result.assertionResults.filter((item) => item.type === "dag_edge");
    const failedEdges = edgeResults.filter((item) => item.status !== "passed");
    const requiredFailures = result.assertionResults.filter((item) => item.required && item.status !== "passed");
    const hasOptionalFailures = result.assertionResults.some((item) => !item.required && item.status === "failed");
    const finalStatus: AgentBenchmarkMetrics["finalStatus"] = result.status === "error"
      ? "blocked"
      : result.status === "failed"
        ? "failed"
        : hasOptionalFailures || result.warnings.length > 0
          ? "partial"
          : "passed";
    const verifiedInputs = result.metrics.verifiedInputCount;

    return {
      success: result.status === "passed",
      finalStatus,
      caseId: result.fixtureId,
      runId: result.runId,
      startedAt: result.startedAt,
      finishedAt: result.finishedAt,
      durationMs,
      strategy,
      taskCount: result.metrics.taskCount,
      completedTaskCount: result.metrics.completedTaskCount,
      failedTaskCount: result.metrics.failedTaskCount,
      retryCount: Math.max(0, result.metrics.attemptCount - result.metrics.taskCount),
      planValid: result.metrics.taskCount > 0 && failedEdges.length === 0,
      expectedRoleCoverage: passRate(roleResults),
      expectedOutputCoverage: passRate(outputResults),
      verifiedInputCount: verifiedInputs,
      verifiedInputCoverage: verifiedInputs > 0 ? result.metrics.upstreamInputReadCount / verifiedInputs : 0,
      upstreamArtifactReadRate: verifiedInputs > 0 ? result.metrics.upstreamInputReadCount / verifiedInputs : 0,
      contextOmissionRate: 0,
      staleFactRejectedCount: 0,
      unverifiedOutputBlockedCount: result.metrics.rejectedOutputClaimCount,
      toolCallCount: result.metrics.toolCallCount,
      toolFailureRate: result.metrics.toolCallCount > 0
        ? result.metrics.failedToolCallCount / result.metrics.toolCallCount
        : 0,
      approvalRequestCount: 0,
      jsonRepairCount: 0,
      artifactCreatedCount: result.metrics.artifactCreatedCount,
      deploymentReady: result.assertionResults.some((item) => item.type === "deployment_ready" && item.status === "passed"),
      reviewerPassed: result.assertionResults.some((item) =>
        item.type === "role_executed" && item.assertionId.includes("reviewer") && item.status === "passed"
      ),
      estimatedInputTokens: 0,
      edgesSatisfied: failedEdges.length === 0,
      missingEdges: failedEdges.map((item) => item.reason),
      warnings: [
        ...result.warnings,
        ...requiredFailures.map((item) => `Required assertion failed: ${item.assertionId}`),
        ...(result.error ? [result.error] : []),
      ],
    };
  });

  const passed = cases.filter((item) => item.finalStatus === "passed" || item.finalStatus === "partial").length;
  return {
    generatedAt: Date.now(),
    strategy,
    totalCases: cases.length,
    passed,
    failed: cases.filter((item) => item.finalStatus === "failed").length,
    errors: cases.filter((item) => item.finalStatus === "blocked").length,
    overallSuccessRate: cases.length > 0 ? passed / cases.length : 0,
    cases,
  };
}

async function generateComparison(
  baselineRunIds: string,
  candidateRunIds: string,
  cases: ReturnType<typeof loadBenchmarkCases>,
): Promise<StrategyComparisonReport> {
  const baseline = baselineRunIds.split(",");
  const candidate = candidateRunIds.split(",");
  const fixtures: StrategyComparisonEntry[] = [];

  for (let index = 0; index < cases.length; index++) {
    const baselineRunId = baseline[index] ?? baseline[0];
    const candidateRunId = candidate[index] ?? candidate[0];
    if (!baselineRunId || !candidateRunId) continue;
    const [baselineResult, candidateResult] = await Promise.all([
      fetchAndEvaluateBenchmarkRun(baselineRunId, cases[index], { strategy: "baseline" }),
      fetchAndEvaluateBenchmarkRun(candidateRunId, cases[index], { strategy: "candidate" }),
    ]);
    fixtures.push({
      fixtureId: cases[index].id,
      baseline: { strategy: "baseline", status: baselineResult.status, metrics: baselineResult.metrics },
      candidate: { strategy: "candidate", status: candidateResult.status, metrics: candidateResult.metrics },
    });
  }

  return {
    baselineStrategy: baselineRunIds,
    candidateStrategy: candidateRunIds,
    comparedAt: Date.now(),
    fixtures,
    summary: {
      baselinePassRate: average(fixtures.map((item) => Number(item.baseline.status === "passed"))),
      candidatePassRate: average(fixtures.map((item) => Number(item.candidate.status === "passed"))),
      baselineAvgReadRate: ratioSum(fixtures.map((item) => [item.baseline.metrics.upstreamInputReadCount, item.baseline.metrics.verifiedInputCount])),
      candidateAvgReadRate: ratioSum(fixtures.map((item) => [item.candidate.metrics.upstreamInputReadCount, item.candidate.metrics.verifiedInputCount])),
      baselineAvgDeployRate: average(fixtures.map((item) => Number(item.baseline.metrics.deploymentReadyCount > 0))),
      candidateAvgDeployRate: average(fixtures.map((item) => Number(item.candidate.metrics.deploymentReadyCount > 0))),
      baselineContextOmissionRate: 0,
      candidateContextOmissionRate: 0,
    },
  };
}

function passRate(results: E2ERunResult["assertionResults"]): number {
  return results.length > 0 ? results.filter((item) => item.status === "passed").length / results.length : 1;
}

function average(values: number[]): number {
  return values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function ratioSum(pairs: Array<[number, number]>): number {
  const numerator = pairs.reduce((sum, pair) => sum + pair[0], 0);
  const denominator = pairs.reduce((sum, pair) => sum + pair[1], 0);
  return denominator > 0 ? numerator / denominator : 0;
}

void main();
