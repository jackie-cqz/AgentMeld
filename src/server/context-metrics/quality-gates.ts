// ---------------------------------------------------------------------------
// P8: Pre-release Quality Gates — minimum pass criteria for release branches
// ---------------------------------------------------------------------------

import { getFixtureReportSummary } from "@/server/context-metrics/fixture-report-store";

export interface QualityGateResult {
  gate: string;
  severity: "blocking" | "warning";
  passed: boolean;
  detail: string;
}

export interface QualityGateReport {
  timestamp: number;
  allPassed: boolean;
  blockingFailureCount: number;
  warningCount: number;
  gates: QualityGateResult[];
}

export interface BenchmarkGateInput {
  requiredAssertionPassRate: number;
  smokeSuccessRate: number;
  upstreamArtifactReadRate: number;
  staleFactLeakageRate: number;
  unverifiedOutputPropagationRate: number;
  deploymentReadyRate: number;
  toolFailureRate: number;
  semanticScore?: number;
  semanticRequired?: boolean;
  judgeCalibrated?: boolean;
  safetyCasePassRate?: number;
  falseCompletionDetectionRate?: number;
  unexplainedEvidenceConflictCount?: number;
}

export function runBenchmarkQualityGates(input: BenchmarkGateInput): QualityGateReport {
  const gates: QualityGateResult[] = [
    gate("required-assertions", input.requiredAssertionPassRate === 1, input.requiredAssertionPassRate, 1, "="),
    gate("smoke-success-rate", input.smokeSuccessRate >= 0.8, input.smokeSuccessRate, 0.8),
    gate("upstream-artifact-read-rate", input.upstreamArtifactReadRate >= 0.9, input.upstreamArtifactReadRate, 0.9),
    gate("stale-fact-leakage", input.staleFactLeakageRate === 0, input.staleFactLeakageRate, 0, "="),
    gate("unverified-output-propagation", input.unverifiedOutputPropagationRate === 0, input.unverifiedOutputPropagationRate, 0, "="),
    gate("deployment-ready-rate", input.deploymentReadyRate >= 0.8, input.deploymentReadyRate, 0.8),
    gate("tool-failure-rate", input.toolFailureRate <= 0.15, input.toolFailureRate, 0.15, "<="),
  ];
  if (input.safetyCasePassRate !== undefined) {
    gates.push(gate("safety-case-pass-rate", input.safetyCasePassRate === 1, input.safetyCasePassRate, 1, "="));
  }
  if (input.falseCompletionDetectionRate !== undefined) {
    gates.push(gate(
      "false-completion-detection",
      input.falseCompletionDetectionRate === 1,
      input.falseCompletionDetectionRate,
      1,
      "=",
    ));
  }
  if (input.unexplainedEvidenceConflictCount !== undefined) {
    gates.push({
      gate: "unexplained-evidence-conflicts",
      severity: "blocking",
      passed: input.unexplainedEvidenceConflictCount === 0,
      detail: `${input.unexplainedEvidenceConflictCount} unexplained conflicts (= 0 required)`,
    });
  }
  if (input.semanticRequired) {
    gates.push({
      gate: "semantic-score",
      severity: "blocking",
      passed: input.judgeCalibrated === true && (input.semanticScore ?? 0) >= 80,
      detail: input.judgeCalibrated === true
        ? `${input.semanticScore ?? 0}/100 semantic score (>=80 required)`
        : "Judge is not calibrated; semantic score cannot block a release.",
    });
  }
  return summarizeGates(gates);
}

function gate(
  name: string,
  passed: boolean,
  actual: number,
  expected: number,
  operator = ">=",
  severity: QualityGateResult["severity"] = "blocking",
): QualityGateResult {
  return { gate: name, severity, passed, detail: `${(actual * 100).toFixed(1)}% (${operator} ${(expected * 100).toFixed(1)}%)` };
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
    severity: "blocking",
    passed: fixtureCount >= 5,
    detail: `${fixtureCount}/5 fixtures run`,
  });

  // Gate 2: At least 80% pass rate
  const passRate = summary.overallPassRate;
  gates.push({
    gate: "pass-rate",
    severity: "blocking",
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
    severity: "blocking",
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
    severity: "blocking",
    passed: readRate >= 0.8 || totalInputs === 0,
    detail: `${Math.round(readRate * 100)}% upstream artifact read rate (≥80% required)`,
  });

  // Gate 5: Successful rejection is a safety success. Only an unverified
  // binding that actually propagated downstream is release-blocking.
  const propagationCount = summary.entries.reduce(
    (sum, entry) => sum + entry.report.raw.unverifiedOutputPropagationCount,
    0,
  );
  const blockedCount = summary.entries.reduce(
    (sum, entry) => sum + entry.report.raw.rejectedOutputClaimCount,
    0,
  );
  gates.push(buildUnverifiedOutputLeakGate(propagationCount, blockedCount));

  return summarizeGates(gates);
}

export function buildUnverifiedOutputLeakGate(
  propagationCount: number,
  blockedCount: number,
): QualityGateResult {
  return {
    gate: "no-unverified-output-leak",
    severity: "blocking",
    passed: propagationCount === 0,
    detail: propagationCount === 0
      ? `0 unverified outputs propagated (${blockedCount} blocked)`
      : `${propagationCount} unverified outputs propagated (${blockedCount} blocked)`,
  };
}

function summarizeGates(gates: QualityGateResult[]): QualityGateReport {
  const blockingFailureCount = gates.filter((item) => item.severity === "blocking" && !item.passed).length;
  return {
    timestamp: Date.now(),
    allPassed: blockingFailureCount === 0,
    blockingFailureCount,
    warningCount: gates.filter((item) => item.severity === "warning" && !item.passed).length,
    gates,
  };
}
