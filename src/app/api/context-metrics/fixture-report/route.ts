import { computeRunMetrics } from "@/server/context-metrics/context-metrics-service";
import type { FixtureReportEntry, FixtureReportSummary } from "@/server/context-metrics/context-metrics-types";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  let body: { fixtures: Array<{ id: string; runId: string }> };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  if (!body.fixtures || !Array.isArray(body.fixtures)) {
    return Response.json({ error: "Body must contain fixtures array." }, { status: 400 });
  }

  const entries: FixtureReportEntry[] = [];
  let passed = 0;
  let failed = 0;
  let errors = 0;

  for (const f of body.fixtures) {
    const result = computeRunMetrics(f.runId);
    if ("error" in result) {
      errors++;
      entries.push({
        fixtureId: f.id, runId: f.runId, status: "error",
        report: { runId: f.runId, raw: emptyRawMetrics(f.runId), derived: emptyDerivedRates() },
        warnings: [result.error], evaluatedAt: Date.now(),
      });
      continue;
    }

    const warnings: string[] = [];
    if (result.raw.missingRequiredInputCount > 0) warnings.push(`${result.raw.missingRequiredInputCount} missing required inputs`);
    if (result.raw.failedTaskCount > 0) warnings.push(`${result.raw.failedTaskCount} tasks failed`);

    const status = result.raw.completedTaskCount >= result.raw.taskCount * 0.5 ? "passed" : "failed";
    if (status === "passed") passed++;
    else failed++;

    entries.push({
      fixtureId: f.id, runId: f.runId, status,
      report: result, warnings, evaluatedAt: Date.now(),
    });
  }

  const summary: FixtureReportSummary = {
    generatedAt: Date.now(),
    totalFixtures: body.fixtures.length,
    passed, failed, errors,
    overallPassRate: body.fixtures.length > 0 ? Math.round((passed / body.fixtures.length) * 100) / 100 : 0,
    entries,
  };

  return Response.json(summary);
}

function emptyRawMetrics(runId: string) {
  return { runId, taskCount: 0, attemptCount: 0, completedTaskCount: 0, failedTaskCount: 0, verifiedInputCount: 0, missingRequiredInputCount: 0, upstreamInputReadCount: 0, upstreamInputUnreadCount: 0, contextIncludedItemCount: 0, contextOmittedItemCount: 0, contextOmittedByBudgetCount: 0, staleRejectedCount: 0, unverifiedRejectedCount: 0, unrelatedRejectedCount: 0, evidenceCount: 0, toolCallCount: 0, failedToolCallCount: 0, verifiedOutputBindingCount: 0, rejectedOutputClaimCount: 0, artifactCreatedCount: 0, deploymentReadyCount: 0 };
}

function emptyDerivedRates() {
  return { upstreamInputHitRate: 0, upstreamArtifactReadRate: 0, contextOmissionRate: 0, unverifiedOutputRejectionRate: 0, toolFailureRate: 0, taskRetryRate: 0, deploymentSuccessRate: 0, taskCompletionRate: 0 };
}
