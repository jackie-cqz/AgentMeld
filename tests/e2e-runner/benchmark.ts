#!/usr/bin/env npx tsx
// ---------------------------------------------------------------------------
// P8: Agent Benchmark Runner — evaluate all fixtures and produce report
//
// Usage:
//   npx tsx tests/e2e-runner/benchmark.ts --run <runId1,runId2,...> --strategy <name>
//   npx tsx tests/e2e-runner/benchmark.ts --compare <runId1> <runId2>
// ---------------------------------------------------------------------------

import * as fs from "node:fs";
import * as path from "node:path";
import type { E2EFixture, E2ERunResult, E2ERunMetrics, StrategyComparisonReport, StrategyComparisonEntry } from "./types";
import type { AgentBenchmarkCase, AgentBenchmarkMetrics, AgentBenchmarkReport } from "@/server/context-metrics/benchmark-types";
import type { ContextStrategyName } from "@/server/context-policy/strategy-registry";

const API_BASE = process.env.AGENTMELD_API_BASE ?? "http://localhost:3000";
const FIXTURES_DIR = path.join(__dirname, "..", "e2e-fixtures");

interface TraceRunResponse {
  conductorRunId: string;
  metrics: {
    taskCount: number; attemptCount: number; completedTaskCount: number; failedTaskCount: number;
    verifiedInputCount: number; missingRequiredInputCount: number;
    upstreamInputReadCount: number; upstreamInputUnreadCount: number;
    toolCallCount: number; failedToolCallCount: number;
    artifactCreatedCount: number; webAppOutputCount: number; deploymentReadyCount: number;
    contextIncludedItemCount: number; contextOmittedItemCount: number;
  };
  tasks: Array<{
    taskId: string; agentId: string; title: string;
    producedBindings: Array<{ outputKey: string; artifactId: string; artifactType: string; artifactTitle: string }>;
    consumedInputs: Array<{ fromTaskId: string; outputKey: string; artifactId: string; bindingVerified: boolean; readByCurrentAttempt: boolean }>;
  }>;
}

async function main() {
  const args = process.argv.slice(2);
  const runArgIdx = args.indexOf("--run");
  const strategyArgIdx = args.indexOf("--strategy");
  const compareIdx = args.indexOf("--compare");

  if (compareIdx >= 0) {
    const baselineRun = args[compareIdx + 1];
    const candidateRun = args[compareIdx + 2];
    if (!baselineRun || !candidateRun) { console.error("Usage: --compare <baselineRunId> <candidateRunId>"); process.exit(1); }
    const report = await generateComparison(baselineRun, candidateRun);
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  if (runArgIdx >= 0) {
    const runIds = args[runArgIdx + 1]?.split(",") ?? [];
    if (runIds.length === 0) { console.error("Usage: --run <runId1,runId2,...> [--strategy <name>]"); process.exit(1); }
    const strategy = (args[strategyArgIdx + 1] ?? "evidence_aware_context") as ContextStrategyName;

    const fixtures = loadFixtures();
    const results: E2ERunResult[] = [];
    for (let i = 0; i < fixtures.length && i < runIds.length; i++) {
      const runId = runIds[i];
      const fixture = fixtures[i];
      const result = await evaluateFixtureRun(runId, fixture, strategy);
      results.push(result);
    }

    const report = buildBenchmarkReport(results, strategy);
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  console.error("Usage: npx tsx tests/e2e-runner/benchmark.ts --run <runIds> --strategy <name> | --compare <baseline> <candidate>");
  process.exit(1);
}

function loadFixtures(): E2EFixture[] {
  if (!fs.existsSync(FIXTURES_DIR)) return [];
  return fs.readdirSync(FIXTURES_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => { try { return JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, f), "utf-8")); } catch { return null; } })
    .filter((f): f is E2EFixture => f != null);
}

async function evaluateFixtureRun(runId: string, fixture: E2EFixture, strategy: string): Promise<E2ERunResult> {
  const startedAt = Date.now();
  try {
    const res = await fetch(`${API_BASE}/api/context-trace/run/${runId}`);
    if (!res.ok) return { fixtureId: fixture.id, runId, startedAt, finishedAt: Date.now(), status: "error", strategy, metrics: emptyMetrics(), criteriaResults: [], artifacts: [], warnings: [], error: `API ${res.status}` };
    const trace = await res.json() as TraceRunResponse;
    if ((trace as unknown as { error: string }).error) return { fixtureId: fixture.id, runId, startedAt, finishedAt: Date.now(), status: "error", strategy, metrics: emptyMetrics(), criteriaResults: [], artifacts: [], warnings: [], error: (trace as unknown as { error: string }).error };

    const finishedAt = Date.now();
    const criteriaResults = fixture.successCriteria.map((c) => {
      const lc = c.toLowerCase();
      let passed = false;
      if (lc.includes("build")) passed = trace.metrics.failedToolCallCount < trace.metrics.toolCallCount;
      else if (lc.includes("deploy")) passed = trace.metrics.deploymentReadyCount > 0;
      else if (lc.includes("read")) passed = trace.metrics.upstreamInputReadCount >= 1;
      else passed = trace.metrics.completedTaskCount > 0;
      return { criterion: c, passed, detail: passed ? "ok" : "not met" };
    });
    const passedCount = criteriaResults.filter((c) => c.passed).length;
    const artifacts = trace.tasks.flatMap((t) => t.producedBindings.map((b) => ({ outputKey: b.outputKey, artifactId: b.artifactId, type: b.artifactType, title: b.artifactTitle })));
    const warnings: string[] = [];
    if (trace.metrics.missingRequiredInputCount > 0) warnings.push(`${trace.metrics.missingRequiredInputCount} missing inputs`);
    if (trace.metrics.upstreamInputUnreadCount > 0) warnings.push(`${trace.metrics.upstreamInputUnreadCount} unread inputs`);

    return {
      fixtureId: fixture.id, runId, startedAt, finishedAt, strategy,
      status: passedCount >= (fixture.minPassCriteria ?? Math.ceil(fixture.successCriteria.length * 0.6)) ? "passed" : "failed",
      metrics: { ...trace.metrics, verifiedOutputBindingCount: 0, rejectedOutputClaimCount: 0 },
      criteriaResults, artifacts, warnings,
    };
  } catch (err) {
    return { fixtureId: fixture.id, runId, startedAt, finishedAt: Date.now(), status: "error", strategy, metrics: emptyMetrics(), criteriaResults: [], artifacts: [], warnings: [], error: String(err) };
  }
}

function buildBenchmarkReport(results: E2ERunResult[], strategy: string): AgentBenchmarkReport {
  const cases: AgentBenchmarkMetrics[] = results.map((r) => ({
    success: r.status === "passed",
    caseId: r.fixtureId, runId: r.runId,
    startedAt: r.startedAt, finishedAt: r.finishedAt,
    durationMs: r.finishedAt - r.startedAt,
    strategy,
    taskCount: r.metrics.taskCount,
    attemptCount: r.metrics.attemptCount,
    completedTaskCount: r.metrics.completedTaskCount,
    failedTaskCount: r.metrics.failedTaskCount,
    verifiedInputCount: r.metrics.verifiedInputCount,
    upstreamInputReadCount: r.metrics.upstreamInputReadCount,
    upstreamInputUnreadCount: r.metrics.upstreamInputUnreadCount ?? 0,
    toolCallCount: r.metrics.toolCallCount,
    failedToolCallCount: r.metrics.failedToolCallCount,
    artifactCreatedCount: r.metrics.artifactCreatedCount,
    webAppOutputCount: r.metrics.webAppOutputCount ?? 0,
    deploymentReadyCount: r.metrics.deploymentReadyCount,
    contextIncludedItemCount: 0,
    contextOmittedItemCount: 0,
    derivedRates: {
      upstreamInputHitRate: r.metrics.verifiedInputCount > 0 ? r.metrics.upstreamInputReadCount / r.metrics.verifiedInputCount : 0,
      upstreamArtifactReadRate: r.metrics.verifiedInputCount > 0 ? r.metrics.upstreamInputReadCount / r.metrics.verifiedInputCount : 0,
      contextOmissionRate: 0, unverifiedOutputRejectionRate: 0,
      toolFailureRate: r.metrics.toolCallCount > 0 ? r.metrics.failedToolCallCount / r.metrics.toolCallCount : 0,
      taskRetryRate: r.metrics.taskCount > 0 ? (r.metrics.attemptCount - r.metrics.taskCount) / r.metrics.taskCount : 0,
      deploymentSuccessRate: r.metrics.webAppOutputCount > 0 ? r.metrics.deploymentReadyCount / r.metrics.webAppOutputCount : 0,
      taskCompletionRate: r.metrics.taskCount > 0 ? r.metrics.completedTaskCount / r.metrics.taskCount : 0,
    },
    edgesSatisfied: r.metrics.upstreamInputUnreadCount === 0,
    missingEdges: r.metrics.upstreamInputUnreadCount > 0 ? [`${r.metrics.upstreamInputUnreadCount} unread inputs`] : [],
    warnings: r.warnings,
  }));

  const passed = cases.filter((c) => c.success).length;
  return {
    generatedAt: Date.now(),
    strategy,
    totalCases: cases.length,
    passed,
    failed: cases.length - passed - cases.filter((c) => c.durationMs === 0).length,
    errors: cases.filter((c) => c.durationMs === 0 && !c.success).length,
    overallSuccessRate: cases.length > 0 ? passed / cases.length : 0,
    cases,
  };
}

async function generateComparison(baselineRunId: string, candidateRunId: string): Promise<StrategyComparisonReport> {
  const fixtures = loadFixtures();
  const entries: StrategyComparisonEntry[] = [];
  let bPass = 0, cPass = 0, bReads = 0, cReads = 0, bInputs = 0, cInputs = 0, bDeploy = 0, cDeploy = 0;

  for (let i = 0; i < fixtures.length; i++) {
    const fixture = fixtures[i];
    // For comparison, both runs use the same fixture set — run IDs are comma-separated
    const bRunId = baselineRunId.split(",")[i] ?? baselineRunId;
    const cRunId = candidateRunId.split(",")[i] ?? candidateRunId;

    try {
      const bRes = await fetch(`${API_BASE}/api/context-trace/run/${bRunId}`);
      const bTrace = bRes.ok ? await bRes.json() as TraceRunResponse : null;
      const cRes = await fetch(`${API_BASE}/api/context-trace/run/${cRunId}`);
      const cTrace = cRes.ok ? await cRes.json() as TraceRunResponse : null;

      if (bTrace && cTrace && !(bTrace as unknown as { error: string }).error && !(cTrace as unknown as { error: string }).error) {
        const bReadRate = bTrace.metrics.verifiedInputCount > 0 ? bTrace.metrics.upstreamInputReadCount / bTrace.metrics.verifiedInputCount : 0;
        const cReadRate = cTrace.metrics.verifiedInputCount > 0 ? cTrace.metrics.upstreamInputReadCount / cTrace.metrics.verifiedInputCount : 0;

        entries.push({
          fixtureId: fixture.id,
          baseline: { strategy: "baseline", status: bTrace.metrics.failedTaskCount === 0 ? "passed" : "failed", metrics: { taskCount: bTrace.metrics.taskCount, attemptCount: bTrace.metrics.attemptCount, completedTaskCount: bTrace.metrics.completedTaskCount, upstreamInputReadCount: bTrace.metrics.upstreamInputReadCount, verifiedInputCount: bTrace.metrics.verifiedInputCount, failedToolCallCount: bTrace.metrics.failedToolCallCount, deploymentReadyCount: bTrace.metrics.deploymentReadyCount } },
          candidate: { strategy: "candidate", status: cTrace.metrics.failedTaskCount === 0 ? "passed" : "failed", metrics: { taskCount: cTrace.metrics.taskCount, attemptCount: cTrace.metrics.attemptCount, completedTaskCount: cTrace.metrics.completedTaskCount, upstreamInputReadCount: cTrace.metrics.upstreamInputReadCount, verifiedInputCount: cTrace.metrics.verifiedInputCount, failedToolCallCount: cTrace.metrics.failedToolCallCount, deploymentReadyCount: cTrace.metrics.deploymentReadyCount } },
        });

        if (bTrace.metrics.failedTaskCount === 0) bPass++;
        if (cTrace.metrics.failedTaskCount === 0) cPass++;
        bReads += bTrace.metrics.upstreamInputReadCount; bInputs += bTrace.metrics.verifiedInputCount;
        cReads += cTrace.metrics.upstreamInputReadCount; cInputs += cTrace.metrics.verifiedInputCount;
        bDeploy += bTrace.metrics.deploymentReadyCount; cDeploy += cTrace.metrics.deploymentReadyCount;
      }
    } catch { /* skip failed fetches */ }
  }

  return {
    baselineStrategy: baselineRunId, candidateStrategy: candidateRunId, comparedAt: Date.now(),
    fixtures: entries,
    summary: {
      baselinePassRate: entries.length > 0 ? bPass / entries.length : 0,
      candidatePassRate: entries.length > 0 ? cPass / entries.length : 0,
      baselineAvgReadRate: bInputs > 0 ? bReads / bInputs : 0,
      candidateAvgReadRate: cInputs > 0 ? cReads / cInputs : 0,
      baselineAvgDeployRate: entries.length > 0 ? bDeploy / entries.length : 0,
      candidateAvgDeployRate: entries.length > 0 ? cDeploy / entries.length : 0,
    },
  };
}

function emptyMetrics(): E2ERunMetrics {
  return { taskCount: 0, attemptCount: 0, completedTaskCount: 0, failedTaskCount: 0, verifiedInputCount: 0, missingRequiredInputCount: 0, upstreamInputReadCount: 0, upstreamInputUnreadCount: 0, toolCallCount: 0, failedToolCallCount: 0, verifiedOutputBindingCount: 0, rejectedOutputClaimCount: 0, artifactCreatedCount: 0, webAppOutputCount: 0, deploymentReadyCount: 0 };
}

main();
