import { listFixtureReports, getFixtureReportSummary } from "@/server/context-metrics/fixture-report-store";
import { gateRequest } from "@/server/api-gate";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const gate = await gateRequest(request);
  if (!gate.allowed) return gate.response;
  const summary = getFixtureReportSummary();
  const recent = summary.entries.slice(0, 20);
  return Response.json({
    summary: {
      totalFixtures: summary.totalFixtures,
      passed: summary.passed,
      failed: summary.failed,
      errors: summary.errors,
      overallPassRate: summary.overallPassRate,
    },
    recent: recent.map((r) => ({
      fixtureId: r.fixtureId,
      runId: r.runId,
      status: r.status,
      evaluatedAt: r.evaluatedAt,
      durationMs: r.report.raw.evidenceCount > 0 ? undefined : undefined, // populated by benchmark runner
      metrics: {
        taskCount: r.report.raw.taskCount,
        completedTaskCount: r.report.raw.completedTaskCount,
        upstreamInputReadCount: r.report.raw.upstreamInputReadCount,
        deploymentReadyCount: r.report.raw.deploymentReadyCount,
        failedToolCallCount: r.report.raw.failedToolCallCount,
        toolCallCount: r.report.raw.toolCallCount,
      },
      warnings: r.warnings,
    })),
  });
}
