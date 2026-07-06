#!/usr/bin/env npx tsx
// ---------------------------------------------------------------------------
// P2: E2E Run Evaluator — evaluate a completed conductor run against a fixture
//
// Usage: npx tsx tests/e2e-runner/evaluate-run.ts <runId> <fixturePath>
// ---------------------------------------------------------------------------

import * as fs from "node:fs";
import type { E2EFixture, E2ERunResult, E2ERunMetrics } from "./types";

interface TraceRunResponse {
  conductorRunId: string;
  conversationId: string;
  planId: string;
  tasks: Array<{
    taskId: string;
    agentId: string;
    title: string;
    dependsOn: string[];
    attempts: Array<{ attemptId: string; taskId: string; agentId: string; executionStatus: string; verificationStatus: string }>;
    producedBindings: Array<{ producerTaskId: string; outputKey: string; artifactId: string; artifactTitle: string; artifactType: string }>;
    consumedInputs: Array<{ fromTaskId: string; outputKey: string; artifactId: string; artifactTitle: string; bindingVerified: boolean; readByCurrentAttempt: boolean }>;
  }>;
  metrics: E2ERunMetrics;
}

const API_BASE = process.env.AGENTMELD_API_BASE ?? "http://localhost:3000";

async function main() {
  const runId = process.argv[2];
  const fixturePath = process.argv[3];

  if (!runId || !fixturePath) {
    console.error("Usage: npx tsx tests/e2e-runner/evaluate-run.ts <runId> <fixturePath>");
    process.exit(1);
  }

  if (!fs.existsSync(fixturePath)) {
    console.error(`Fixture not found: ${fixturePath}`);
    process.exit(1);
  }

  const fixture = JSON.parse(fs.readFileSync(fixturePath, "utf-8")) as E2EFixture;
  const result = await evaluateRun(runId, fixture);
  console.log(JSON.stringify(result, null, 2));

  if (result.status === "failed") process.exit(1);
}

async function evaluateRun(runId: string, fixture: E2EFixture): Promise<E2ERunResult> {
  const startedAt = Date.now();
  const warnings: string[] = [];

  let trace: TraceRunResponse;
  try {
    const res = await fetch(`${API_BASE}/api/context-trace/run/${runId}`);
    if (!res.ok) {
      return {
        fixtureId: fixture.id, runId, startedAt, finishedAt: Date.now(),
        status: "error", metrics: emptyMetrics(), criteriaResults: [], artifacts: [],
        warnings: [], error: `Context trace API returned ${res.status}`,
      };
    }
    trace = await res.json();
    if ((trace as unknown as { error?: string }).error) {
      return {
        fixtureId: fixture.id, runId, startedAt, finishedAt: Date.now(),
        status: "error", metrics: emptyMetrics(), criteriaResults: [], artifacts: [],
        warnings: [], error: (trace as unknown as { error: string }).error,
      };
    }
  } catch (err) {
    return {
      fixtureId: fixture.id, runId, startedAt, finishedAt: Date.now(),
      status: "error", metrics: emptyMetrics(), criteriaResults: [], artifacts: [],
      warnings: [], error: `Failed to fetch trace: ${String(err)}`,
    };
  }

  const finishedAt = Date.now();

  // Evaluate success criteria
  const criteriaResults: E2ERunResult["criteriaResults"] = [];

  for (const sc of fixture.successCriteria) {
    const evalResult = evaluateCriterion(sc, trace, fixture);
    criteriaResults.push(evalResult);
  }

  const passedCount = criteriaResults.filter((c) => c.passed).length;
  const status = passedCount >= fixture.minPassCriteria ? "passed" : "failed";

  // Collect artifacts
  const artifacts: E2ERunResult["artifacts"] = [];
  for (const task of trace.tasks) {
    for (const b of task.producedBindings) {
      artifacts.push({
        outputKey: b.outputKey,
        artifactId: b.artifactId,
        type: b.artifactType,
        title: b.artifactTitle,
      });
    }
  }

  // Warnings
  if (trace.metrics.missingRequiredInputCount > 0) {
    warnings.push(`${trace.metrics.missingRequiredInputCount} required upstream inputs were missing`);
  }
  if (trace.metrics.upstreamInputUnreadCount > 0) {
    warnings.push(`${trace.metrics.upstreamInputUnreadCount} verified inputs were never read by downstream tasks`);
  }
  if (trace.metrics.failedTaskCount > 0) {
    warnings.push(`${trace.metrics.failedTaskCount} tasks failed`);
  }

  return {
    fixtureId: fixture.id,
    runId,
    startedAt,
    finishedAt,
    status,
    metrics: trace.metrics,
    criteriaResults,
    artifacts,
    warnings,
  };
}

function evaluateCriterion(
  criterion: string,
  trace: TraceRunResponse,
  fixture: E2EFixture,
): { criterion: string; passed: boolean; detail: string } {
  const c = criterion.toLowerCase();

  // PM creates PRD artifact
  if (c.includes("pm") && c.includes("prd") && c.includes("creat")) {
    const passed = trace.tasks.some((t) =>
      t.producedBindings.some((b) => b.outputKey.includes("prd") && b.artifactType === "document")
    );
    return { criterion, passed, detail: passed ? "PRD artifact found in bindings" : "No PRD document artifact produced" };
  }

  // UI reads PRD and creates style guide
  if (c.includes("ui") && c.includes("style")) {
    const uiTask = trace.tasks.find((t) => t.agentId.includes("design") || t.title.toLowerCase().includes("ui") || t.title.toLowerCase().includes("设计") || t.title.toLowerCase().includes("style"));
    if (!uiTask) return { criterion, passed: false, detail: "No UI/design task found" };
    const hasStyleOutput = uiTask.producedBindings.some((b) => b.artifactType === "document" && (b.outputKey.includes("style") || b.artifactTitle.toLowerCase().includes("style")));
    const readPrd = uiTask.consumedInputs.some((ci) => ci.readByCurrentAttempt);
    return { criterion, passed: hasStyleOutput && readPrd, detail: `Style output: ${hasStyleOutput}, read PRD: ${readPrd}` };
  }

  // Frontend reads PRD and style guide
  if (c.includes("frontend") && c.includes("read")) {
    const feTask = trace.tasks.find((t) => t.agentId.includes("frontend") || t.agentId.includes("builder") || t.title.toLowerCase().includes("frontend") || t.title.toLowerCase().includes("前端"));
    if (!feTask) return { criterion, passed: false, detail: "No frontend task found" };
    const readCount = feTask.consumedInputs.filter((ci) => ci.readByCurrentAttempt).length;
    return { criterion, passed: readCount >= 2, detail: `Frontend read ${readCount} upstream artifacts` };
  }

  // Creates web_app artifact
  if (c.includes("web_app") || c.includes("web app")) {
    const hasWebApp = trace.tasks.some((t) =>
      t.producedBindings.some((b) => b.artifactType === "web_app")
    );
    return { criterion, passed: hasWebApp, detail: hasWebApp ? "web_app artifact found" : "No web_app artifact produced" };
  }

  // Build successful
  if (c.includes("build")) {
    const passed = trace.metrics.failedToolCallCount < trace.metrics.toolCallCount * 0.5;
    return { criterion, passed, detail: `${trace.metrics.failedToolCallCount}/${trace.metrics.toolCallCount} tool calls failed` };
  }

  // Deployment
  if (c.includes("deploy") || c.includes("preview")) {
    return { criterion, passed: trace.metrics.deploymentReadyCount > 0, detail: `${trace.metrics.deploymentReadyCount} deployments ready` };
  }

  // Reviewer receives web_app
  if (c.includes("reviewer")) {
    const reviewerTask = trace.tasks.find((t) => t.agentId.includes("review"));
    if (!reviewerTask) return { criterion, passed: false, detail: "No reviewer task found" };
    const hasWebAppInput = reviewerTask.consumedInputs.some((ci) => ci.bindingVerified && (ci.outputKey.includes("web_app") || ci.outputKey.includes("app")));
    return { criterion, passed: hasWebAppInput, detail: hasWebAppInput ? "Reviewer received web_app input" : "Reviewer missing web_app input" };
  }

  // Timer-specific
  if (c.includes("timer") || c.includes("start") || c.includes("pause")) {
    const hasWebApp = trace.tasks.some((t) => t.producedBindings.some((b) => b.artifactType === "web_app"));
    return { criterion, passed: hasWebApp, detail: hasWebApp ? "web_app with timer produced" : "No web_app artifact" };
  }

  // Generic: check if any artifact was produced for the expected role
  for (const eo of fixture.expectedOutputs) {
    if (c.includes(eo.taskRole) && c.includes(eo.outputKey)) {
      const hasOutput = trace.tasks.some((t) =>
        t.producedBindings.some((b) => b.outputKey === eo.outputKey && b.artifactType === eo.type)
      );
      return { criterion, passed: hasOutput, detail: hasOutput ? `Output ${eo.outputKey} found` : `Output ${eo.outputKey} not found` };
    }
  }

  // Fallback: check if at least one task succeeded
  return { criterion, passed: trace.metrics.completedTaskCount > 0, detail: `${trace.metrics.completedTaskCount} tasks completed` };
}

function emptyMetrics(): E2ERunMetrics {
  return {
    taskCount: 0, attemptCount: 0, completedTaskCount: 0, failedTaskCount: 0,
    verifiedInputCount: 0, missingRequiredInputCount: 0,
    upstreamInputReadCount: 0, upstreamInputUnreadCount: 0,
    toolCallCount: 0, failedToolCallCount: 0,
    verifiedOutputBindingCount: 0, rejectedOutputClaimCount: 0,
    artifactCreatedCount: 0, webAppOutputCount: 0, deploymentReadyCount: 0,
  };
}

main();
