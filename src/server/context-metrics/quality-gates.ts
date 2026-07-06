// ---------------------------------------------------------------------------
// P8: Pre-release Quality Gates — minimum pass criteria for release branches
// ---------------------------------------------------------------------------

import type { FixtureReportEntry } from "@/server/context-metrics/context-metrics-types";
import { getFixtureReportSummary } from "@/server/context-metrics/fixture-report-store";

export interface QualityGateResult {
  gate: string;
  passed: boolean;
  detail: string;
}

export interface QualityGateReport {
  timestamp: number;
  allPassed: boolean;
  gates: QualityGateResult[];
}

/**
 * Run pre-release quality gates against saved fixture reports.
 * Returns a report with pass/fail for each gate.
 */
export function runQualityGates(): QualityGateReport {
  const summary = getFixtureReportSummary();
  const gates: QualityGateResult[] = [];

  // Gate 1: At least 5 fixtures run
  const fixtureCount = summary.totalFixtures;
  gates.push({
    gate: "minimum-fixtures",
    passed: fixtureCount >= 5,
    detail: `${fixtureCount}/5 fixtures run`,
  });

  // Gate 2: At least 80% pass rate
  const passRate = summary.overallPassRate;
  gates.push({
    gate: "pass-rate",
    passed: passRate >= 0.8,
    detail: `${Math.round(passRate * 100)}% pass rate (≥80% required)`,
  });

  // Gate 3: At least one web_app artifact in passing runs
  const passedEntries = summary.entries.filter((e) => e.status === "passed");
  const webAppCount = passedEntries.filter(
    (e) => e.report.raw.webAppOutputCount > 0 || e.report.raw.deploymentReadyCount > 0
  ).length;
  gates.push({
    gate: "web-app-artifacts",
    passed: passedEntries.length === 0 || webAppCount > 0,
    detail: `${webAppCount}/${passedEntries.length} passing runs have web_app artifacts`,
  });

  // Gate 4: Downstream artifact read rate ≥ 80%
  let totalReads = 0;
  let totalInputs = 0;
  for (const entry of passedEntries) {
    totalReads += entry.report.raw.upstreamInputReadCount;
    totalInputs += entry.report.raw.verifiedInputCount;
  }
  const readRate = totalInputs > 0 ? totalReads / totalInputs : 0;
  gates.push({
    gate: "artifact-read-rate",
    passed: readRate >= 0.8 || totalInputs === 0,
    detail: `${Math.round(readRate * 100)}% upstream artifact read rate (≥80% required)`,
  });

  // Gate 5: No unverified output bindings leak
  const rejectedCount = summary.entries.reduce((s, e) => s + e.report.raw.rejectedOutputClaimCount, 0);
  gates.push({
    gate: "no-unverified-output-leak",
    passed: rejectedCount === 0,
    detail: rejectedCount === 0 ? "0 unverified outputs leaked" : `${rejectedCount} unverified outputs leaked!`,
  });

  return {
    timestamp: Date.now(),
    allPassed: gates.every((g) => g.passed),
    gates,
  };
}
