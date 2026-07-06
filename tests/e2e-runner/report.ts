#!/usr/bin/env npx tsx
// ---------------------------------------------------------------------------
// P2: E2E Report Generator — run all fixtures and produce a summary report
//
// Usage: npx tsx tests/e2e-runner/report.ts [--fixture <path>]
//   Without args: runs all fixtures in tests/e2e-fixtures/
//   With --fixture: runs a single fixture
//
// NOTE: This requires the AgentMeld dev server to be running and a conductor
// run to have completed. It evaluates existing runs via the context-trace API.
// For fully automated E2E, use run-fixture.ts to trigger a run first.
// ---------------------------------------------------------------------------

import * as fs from "node:fs";
import * as path from "node:path";
import type { E2EFixture, E2ERunResult } from "./types";

const API_BASE = process.env.AGENTMELD_API_BASE ?? "http://localhost:3000";
const FIXTURES_DIR = path.join(__dirname, "..", "e2e-fixtures");

interface ReportSummary {
  generatedAt: number;
  totalFixtures: number;
  passed: number;
  failed: number;
  errors: number;
  results: E2ERunResult[];
}

async function main() {
  const args = process.argv.slice(2);
  const fixtureArg = args.indexOf("--fixture");
  const runIdArg = args.indexOf("--run");

  if (runIdArg >= 0 && fixtureArg >= 0) {
    // Evaluate a specific run against a fixture
    const runId = args[runIdArg + 1];
    const fixturePath = args[fixtureArg + 1];
    if (!runId || !fixturePath) {
      console.error("Usage: npx tsx tests/e2e-runner/report.ts --run <runId> --fixture <path>");
      process.exit(1);
    }
    const fixture = JSON.parse(fs.readFileSync(fixturePath, "utf-8")) as E2EFixture;
    const result = await evaluateRunDirect(runId, fixture);
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  // Scan all fixtures and report what exists (full E2E needs a live run)
  const files = fs.readdirSync(FIXTURES_DIR).filter((f) => f.endsWith(".json"));
  const fixtures: E2EFixture[] = [];
  for (const f of files) {
    try {
      fixtures.push(JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, f), "utf-8")));
    } catch { console.error(`Skipping invalid fixture: ${f}`); }
  }

  console.log(JSON.stringify({
    generatedAt: Date.now(),
    totalFixtures: fixtures.length,
    fixtures: fixtures.map((f) => ({ id: f.id, title: f.title, description: f.description, expectedTasks: f.expectedTasks, successCriteria: f.successCriteria })),
    note: "E2E evaluation requires a live AgentMeld server and completed conductor runs. Use --run <runId> --fixture <path> to evaluate a specific run.",
  }, null, 2));
}

async function evaluateRunDirect(runId: string, fixture: E2EFixture): Promise<E2ERunResult> {
  const startedAt = Date.now();
  try {
    const res = await fetch(`${API_BASE}/api/context-trace/run/${runId}`);
    if (!res.ok) {
      return { fixtureId: fixture.id, runId, startedAt, finishedAt: Date.now(), status: "error", metrics: emptyMetrics(), criteriaResults: [], artifacts: [], warnings: [], error: `API returned ${res.status}` };
    }
    const trace = await res.json();
    if (trace.error) {
      return { fixtureId: fixture.id, runId, startedAt, finishedAt: Date.now(), status: "error", metrics: emptyMetrics(), criteriaResults: [], artifacts: [], warnings: [], error: trace.error };
    }

    const criteriaResults: E2ERunResult["criteriaResults"] = [];
    for (const sc of fixture.successCriteria) {
      const c = sc.toLowerCase();
      let passed = false;
      let detail = "";
      if (c.includes("pm") && c.includes("prd")) { passed = trace.tasks.some((t: { producedBindings: Array<{ outputKey: string; artifactType: string }> }) => t.producedBindings.some((b: { outputKey: string; artifactType: string }) => b.outputKey.includes("prd"))); detail = passed ? "found" : "not found"; }
      else if (c.includes("web_app") || c.includes("web app")) { passed = trace.tasks.some((t: { producedBindings: Array<{ artifactType: string }> }) => t.producedBindings.some((b: { artifactType: string }) => b.artifactType === "web_app")); detail = passed ? "found" : "not found"; }
      else if (c.includes("deploy")) { passed = trace.metrics.deploymentReadyCount > 0; detail = `${trace.metrics.deploymentReadyCount} deployments`; }
      else if (c.includes("read")) { passed = trace.metrics.upstreamInputReadCount >= 2; detail = `${trace.metrics.upstreamInputReadCount} reads`; }
      else if (c.includes("build")) { passed = trace.metrics.failedToolCallCount < trace.metrics.toolCallCount; detail = `${trace.metrics.failedToolCallCount} failures`; }
      else { passed = trace.metrics.completedTaskCount > 0; detail = `${trace.metrics.completedTaskCount} completed`; }
      criteriaResults.push({ criterion: sc, passed, detail });
    }

    const passedCount = criteriaResults.filter((c) => c.passed).length;
    const artifacts = trace.tasks.flatMap((t: { producedBindings: Array<{ outputKey: string; artifactId: string; artifactType: string; artifactTitle: string }> }) => t.producedBindings.map((b: { outputKey: string; artifactId: string; artifactType: string; artifactTitle: string }) => ({ outputKey: b.outputKey, artifactId: b.artifactId, type: b.artifactType, title: b.artifactTitle })));

    return {
      fixtureId: fixture.id, runId, startedAt, finishedAt: Date.now(),
      status: passedCount >= fixture.minPassCriteria ? "passed" : "failed",
      metrics: trace.metrics, criteriaResults, artifacts, warnings: [],
    };
  } catch (err) {
    return { fixtureId: fixture.id, runId, startedAt, finishedAt: Date.now(), status: "error", metrics: emptyMetrics(), criteriaResults: [], artifacts: [], warnings: [], error: String(err) };
  }
}

function emptyMetrics() { return { taskCount: 0, attemptCount: 0, completedTaskCount: 0, failedTaskCount: 0, verifiedInputCount: 0, missingRequiredInputCount: 0, upstreamInputReadCount: 0, upstreamInputUnreadCount: 0, toolCallCount: 0, failedToolCallCount: 0, verifiedOutputBindingCount: 0, rejectedOutputClaimCount: 0, artifactCreatedCount: 0, webAppOutputCount: 0, deploymentReadyCount: 0 }; }

main();
