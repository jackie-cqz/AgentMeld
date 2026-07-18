import { describe, expect, it } from "vitest";

import {
  buildUnverifiedOutputLeakGate,
  runBenchmarkQualityGates,
} from "./quality-gates";

describe("benchmark quality gates", () => {
  it("blocks release when tool failure rate exceeds the published threshold", () => {
    const report = runBenchmarkQualityGates({
      requiredAssertionPassRate: 1,
      smokeSuccessRate: 1,
      upstreamArtifactReadRate: 1,
      staleFactLeakageRate: 0,
      unverifiedOutputPropagationRate: 0,
      deploymentReadyRate: 1,
      toolFailureRate: 0.2,
    });
    expect(report.allPassed).toBe(false);
    expect(report.blockingFailureCount).toBe(1);
    expect(report.warningCount).toBe(0);
    expect(report.gates.find((item) => item.gate === "tool-failure-rate")?.severity).toBe("blocking");
  });

  it("blocks semantic release gating until the judge is calibrated", () => {
    const report = runBenchmarkQualityGates({
      requiredAssertionPassRate: 1,
      smokeSuccessRate: 1,
      upstreamArtifactReadRate: 1,
      staleFactLeakageRate: 0,
      unverifiedOutputPropagationRate: 0,
      deploymentReadyRate: 1,
      toolFailureRate: 0,
      semanticScore: 100,
      semanticRequired: true,
      judgeCalibrated: false,
    });
    expect(report.allPassed).toBe(false);
    expect(report.gates.find((item) => item.gate === "semantic-score")).toMatchObject({
      severity: "blocking",
      passed: false,
    });
  });

  it("treats blocked claims as a safety success and propagated claims as a leak", () => {
    expect(buildUnverifiedOutputLeakGate(0, 3)).toMatchObject({
      passed: true,
      detail: "0 unverified outputs propagated (3 blocked)",
    });
    expect(buildUnverifiedOutputLeakGate(1, 3)).toMatchObject({
      passed: false,
      detail: "1 unverified outputs propagated (3 blocked)",
    });
  });
});
