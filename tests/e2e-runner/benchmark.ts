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
  const allIdx = args.indexOf("--all");

  const fixtures = loadFixtures();

  // --all: list all fixtures and their status (informational, no run IDs needed)
  if (allIdx >= 0 && runArgIdx < 0) {
    console.log(JSON.stringify({
      generatedAt: Date.now(),
      totalFixtures: fixtures.length,
      fixtures: fixtures.map((f) => ({
        id: f.id,
        title: f.title,
        category: f.id.includes("fix") ? "debugging" : "web_app",
        expectedRoles: f.expectedTasks,
        expectedOutputs: f.expectedOutputs.map((eo) => `${eo.taskRole}.${eo.outputKey} (${eo.type})`),
        successCriteria: f.successCriteria,
        minPassCriteria: f.minPassCriteria,
      })),
      usage: {
        single: "pnpm agent:bench --run <runId> --fixture <fixtureId>",
        evaluateAll: "pass comma-separated run IDs matching fixture order: pnpm agent:bench --run <id1,id2,...> --all",
        compare: "pnpm agent:bench --compare <baselineRun> <candidateRun>",
      },
    }, null, 2));
    return;
  }

  if (compareIdx >= 0) {
    const baselineRun = args[compareIdx + 1];
    const candidateRun = args[compareIdx + 2];
    if (!baselineRun || !candidateRun) { console.error("Usage: --compare <baselineRunId> <candidateRunId>"); process.exit(1); }
    const report = await generateComparison(baselineRun, candidateRun, fixtures);
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  if (runArgIdx >= 0) {
    const runIds = args[runArgIdx + 1]?.split(",") ?? [];
    if (runIds.length === 0) { console.error("Usage: --run <runId1,runId2,...> [--strategy <name>]"); process.exit(1); }
    const strategy = (args[strategyArgIdx + 1] ?? "evidence_aware_context") as ContextStrategyName;

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
  const cases: AgentBenchmarkMetrics[] = results.map((r) => {
    const durationMs = r.finishedAt - r.startedAt;
    const retryCount = Math.max(0, r.metrics.attemptCount - r.metrics.taskCount);
    const verifiedInputs = r.metrics.verifiedInputCount;
    const reads = r.metrics.upstreamInputReadCount;
    const webApps = r.metrics.webAppOutputCount ?? 0;
    const completed = r.metrics.completedTaskCount;
    const total = r.metrics.taskCount;

    let finalStatus: AgentBenchmarkMetrics["finalStatus"] = "failed";
    if (r.status === "passed") {
      finalStatus = r.warnings.length > 0 ? "partial" : "passed";
    } else if (r.status === "error") {
      finalStatus = "blocked";
    }

    return {
      success: r.status === "passed",
      finalStatus,
      caseId: r.fixtureId, runId: r.runId,
      startedAt: r.startedAt, finishedAt: r.finishedAt, durationMs, strategy,
      taskCount: total, completedTaskCount: completed, failedTaskCount: r.metrics.failedTaskCount,
      retryCount,
      planValid: total > 0,
      expectedRoleCoverage: total > 0 ? completed / total : 0,
      expectedOutputCoverage: webApps > 0 ? 1 : (r.metrics.artifactCreatedCount > 0 ? 0.5 : 0),
      verifiedInputCount: verifiedInputs,
      verifiedInputCoverage: verifiedInputs > 0 ? reads / verifiedInputs : 0,
      upstreamArtifactReadRate: verifiedInputs > 0 ? reads / verifiedInputs : 0,
      contextOmissionRate: 0,
      staleFactRejectedCount: 0,
      unverifiedOutputBlockedCount: r.metrics.rejectedOutputClaimCount ?? 0,
      toolCallCount: r.metrics.toolCallCount,
      toolFailureRate: r.metrics.toolCallCount > 0 ? r.metrics.failedToolCallCount / r.metrics.toolCallCount : 0,
      approvalRequestCount: 0,
      jsonRepairCount: 0,
      artifactCreatedCount: r.metrics.artifactCreatedCount,
      deploymentReady: r.metrics.deploymentReadyCount > 0,
      reviewerPassed: r.status === "passed",
      estimatedInputTokens: 0,
      edgesSatisfied: r.metrics.upstreamInputUnreadCount === 0,
      missingEdges: r.metrics.upstreamInputUnreadCount > 0 ? [`${r.metrics.upstreamInputUnreadCount} unread inputs`] : [],
      warnings: r.warnings,
    };
  });

  const passed = cases.filter((c) => c.finalStatus === "passed").length;
  const partial = cases.filter((c) => c.finalStatus === "partial").length;
  return {
    generatedAt: Date.now(),
    strategy,
    totalCases: cases.length,
    passed: passed + partial,
    failed: cases.filter((c) => c.finalStatus === "failed").length,
    errors: cases.filter((c) => c.finalStatus === "blocked").length,
    overallSuccessRate: cases.length > 0 ? (passed + partial) / cases.length : 0,
    cases,
  };
}

async function generateComparison(baselineRunId: string, candidateRunId: string, fixtures: E2EFixture[]): Promise<StrategyComparisonReport> {
  const entries: StrategyComparisonEntry[] = [];
  let bPass = 0, cPass = 0, bReads = 0, cReads = 0, bInputs = 0, cInputs = 0, bDeploy = 0, cDeploy = 0;
  let bOmitted = 0, cOmitted = 0, bIncluded = 0, cIncluded = 0;

  for (let i = 0; i < fixtures.length; i++) {
    const bRunId = baselineRunId.split(",")[i] ?? baselineRunId;
    const cRunId = candidateRunId.split(",")[i] ?? candidateRunId;

    try {
      const [bTraceRes, bMetricsRes, cTraceRes, cMetricsRes] = await Promise.all([
        fetch(`${API_BASE}/api/context-trace/run/${bRunId}`),
        fetch(`${API_BASE}/api/context-metrics/run/${bRunId}`),
        fetch(`${API_BASE}/api/context-trace/run/${cRunId}`),
        fetch(`${API_BASE}/api/context-metrics/run/${cRunId}`),
      ]);

      const bTrace = (bTraceRes.ok ? await bTraceRes.json() : null) as TraceRunResponse | null;
      const bMetrics = (bMetricsRes.ok ? await bMetricsRes.json() : null) as { raw: { contextIncludedItemCount: number; contextOmittedItemCount: number; rejectedOutputClaimCount: number; verifiedOutputBindingCount: number } } | null;
      const cTrace = (cTraceRes.ok ? await cTraceRes.json() : null) as TraceRunResponse | null;
      const cMetrics = (cMetricsRes.ok ? await cMetricsRes.json() : null) as { raw: { contextIncludedItemCount: number; contextOmittedItemCount: number; rejectedOutputClaimCount: number; verifiedOutputBindingCount: number } } | null;

      if (bTrace && cTrace && !(bTrace as unknown as { error: string }).error && !(cTrace as unknown as { error: string }).error) {
        entries.push({
          fixtureId: fixtures[i].id,
          baseline: { strategy: "baseline", status: bTrace.metrics.failedTaskCount === 0 ? "passed" : "failed", metrics: { taskCount: bTrace.metrics.taskCount, attemptCount: bTrace.metrics.attemptCount, completedTaskCount: bTrace.metrics.completedTaskCount, upstreamInputReadCount: bTrace.metrics.upstreamInputReadCount, verifiedInputCount: bTrace.metrics.verifiedInputCount, failedToolCallCount: bTrace.metrics.failedToolCallCount, deploymentReadyCount: bTrace.metrics.deploymentReadyCount } },
          candidate: { strategy: "candidate", status: cTrace.metrics.failedTaskCount === 0 ? "passed" : "failed", metrics: { taskCount: cTrace.metrics.taskCount, attemptCount: cTrace.metrics.attemptCount, completedTaskCount: cTrace.metrics.completedTaskCount, upstreamInputReadCount: cTrace.metrics.upstreamInputReadCount, verifiedInputCount: cTrace.metrics.verifiedInputCount, failedToolCallCount: cTrace.metrics.failedToolCallCount, deploymentReadyCount: cTrace.metrics.deploymentReadyCount } },
        });

        if (bTrace.metrics.failedTaskCount === 0) bPass++;
        if (cTrace.metrics.failedTaskCount === 0) cPass++;
        bReads += bTrace.metrics.upstreamInputReadCount; bInputs += bTrace.metrics.verifiedInputCount;
        cReads += cTrace.metrics.upstreamInputReadCount; cInputs += cTrace.metrics.verifiedInputCount;
        bDeploy += bTrace.metrics.deploymentReadyCount; cDeploy += cTrace.metrics.deploymentReadyCount;
        if (bMetrics) { bOmitted += bMetrics.raw.contextOmittedItemCount; bIncluded += bMetrics.raw.contextIncludedItemCount; }
        if (cMetrics) { cOmitted += cMetrics.raw.contextOmittedItemCount; cIncluded += cMetrics.raw.contextIncludedItemCount; }
      }
    } catch { /* skip */ }
  }

  const bTotal = bIncluded + bOmitted;
  const cTotal = cIncluded + cOmitted;

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
      baselineContextOmissionRate: bTotal > 0 ? bOmitted / bTotal : 0,
      candidateContextOmissionRate: cTotal > 0 ? cOmitted / cTotal : 0,
    } as StrategyComparisonReport["summary"],
  };
}

function emptyMetrics(): E2ERunMetrics {
  return { taskCount: 0, attemptCount: 0, completedTaskCount: 0, failedTaskCount: 0, verifiedInputCount: 0, missingRequiredInputCount: 0, upstreamInputReadCount: 0, upstreamInputUnreadCount: 0, toolCallCount: 0, failedToolCallCount: 0, verifiedOutputBindingCount: 0, rejectedOutputClaimCount: 0, artifactCreatedCount: 0, webAppOutputCount: 0, deploymentReadyCount: 0 };
}

main();
