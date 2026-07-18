import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  computeCalibration,
  evaluateCalibration,
  loadCalibrationDataset,
} from "./judge-calibration";

describe("judge calibration", () => {
  it("computes quadratic weighted kappa for ordinal verdicts", () => {
    const metrics = computeCalibration([
      { humanVerdict: "failed", judgeVerdict: "failed", humanScore: 20, judgeScore: 18 },
      { humanVerdict: "needs_human_review", judgeVerdict: "needs_human_review", humanScore: 55, judgeScore: 58 },
      { humanVerdict: "passed", judgeVerdict: "passed", humanScore: 90, judgeScore: 88 },
    ]);
    expect(metrics.verdictAgreement).toBe(1);
    expect(metrics.weightedKappa).toBe(1);
  });

  it("loads the versioned reference set and enforces every release threshold", () => {
    const dataset = loadCalibrationDataset(path.join(
      process.cwd(),
      "tests", "agent-benchmark", "judges", "calibration", "collaboration-v1.json",
    ));
    const report = evaluateCalibration(dataset);
    expect(report.absolute.sampleCount).toBeGreaterThanOrEqual(20);
    expect(report.pairwise.sampleCount).toBeGreaterThanOrEqual(10);
    expect(report.calibrated).toBe(true);
    expect(Object.values(report.checks).every(Boolean)).toBe(true);
  });
});
