import fs from "node:fs";

export type CalibrationVerdict = "passed" | "failed" | "needs_human_review";

export interface CalibrationSample {
  id?: string;
  humanVerdict: CalibrationVerdict;
  judgeVerdict: CalibrationVerdict;
  humanScore: number;
  judgeScore: number;
}

export interface PairwiseCalibrationSample {
  id?: string;
  forwardWinner: "baseline" | "candidate" | "tie";
  reverseWinner: "baseline" | "candidate" | "tie";
  forwardLabel: "A" | "B" | "tie";
  reverseLabel: "A" | "B" | "tie";
}

export interface JudgeCalibrationDataset {
  schemaVersion: 1;
  datasetVersion: string;
  labeledAt: number;
  labelSource: string;
  judgeProvider: string;
  judgeModel: string;
  promptVersion: string;
  rubricVersion: string;
  samples: CalibrationSample[];
  pairwiseSamples: PairwiseCalibrationSample[];
}

export interface CalibrationThresholds {
  minimumSamples: number;
  minimumPairwiseSamples: number;
  minimumVerdictAgreement: number;
  minimumWeightedKappa: number;
  minimumPairwiseConsistency: number;
  maximumPositionBiasRate: number;
}

export const DEFAULT_CALIBRATION_THRESHOLDS: CalibrationThresholds = {
  minimumSamples: 20,
  minimumPairwiseSamples: 10,
  minimumVerdictAgreement: 0.8,
  minimumWeightedKappa: 0.6,
  minimumPairwiseConsistency: 0.85,
  maximumPositionBiasRate: 0.1,
};

export function computeCalibration(samples: CalibrationSample[]) {
  if (samples.length === 0) {
    return { sampleCount: 0, verdictAgreement: 0, weightedKappa: 0, meanAbsoluteScoreError: 0 };
  }
  const labels: CalibrationVerdict[] = ["failed", "needs_human_review", "passed"];
  const labelIndex = new Map(labels.map((label, index) => [label, index]));
  const matrix = labels.map(() => labels.map(() => 0));
  for (const sample of samples) {
    matrix[labelIndex.get(sample.humanVerdict)!][labelIndex.get(sample.judgeVerdict)!] += 1;
  }
  const humanMarginals = matrix.map((row) => row.reduce((sum, count) => sum + count, 0));
  const judgeMarginals = labels.map((_, column) => matrix.reduce((sum, row) => sum + row[column], 0));
  let observedAgreement = 0;
  let expectedAgreement = 0;
  const denominator = (labels.length - 1) ** 2;
  for (let human = 0; human < labels.length; human += 1) {
    for (let judge = 0; judge < labels.length; judge += 1) {
      const weight = 1 - ((human - judge) ** 2) / denominator;
      observedAgreement += weight * (matrix[human][judge] / samples.length);
      expectedAgreement += weight
        * (humanMarginals[human] / samples.length)
        * (judgeMarginals[judge] / samples.length);
    }
  }
  const exactAgreement = samples.filter((sample) => sample.humanVerdict === sample.judgeVerdict).length / samples.length;
  return {
    sampleCount: samples.length,
    verdictAgreement: exactAgreement,
    weightedKappa: expectedAgreement < 1 ? (observedAgreement - expectedAgreement) / (1 - expectedAgreement) : 1,
    meanAbsoluteScoreError: samples.reduce(
      (sum, sample) => sum + Math.abs(sample.humanScore - sample.judgeScore),
      0,
    ) / samples.length,
  };
}

export function computePairwiseCalibration(samples: PairwiseCalibrationSample[]) {
  if (samples.length === 0) return { sampleCount: 0, orderConsistency: 0, positionBiasRate: 0 };
  const consistentCount = samples.filter((sample) => sample.forwardWinner === sample.reverseWinner).length;
  const positionBiasCount = samples.filter((sample) => (
    sample.forwardWinner !== sample.reverseWinner
    && sample.forwardLabel !== "tie"
    && sample.forwardLabel === sample.reverseLabel
  )).length;
  return {
    sampleCount: samples.length,
    orderConsistency: consistentCount / samples.length,
    positionBiasRate: positionBiasCount / samples.length,
  };
}

export function evaluateCalibration(
  dataset: JudgeCalibrationDataset,
  thresholds: CalibrationThresholds = DEFAULT_CALIBRATION_THRESHOLDS,
) {
  const absolute = computeCalibration(dataset.samples);
  const pairwise = computePairwiseCalibration(dataset.pairwiseSamples);
  const checks = {
    sampleCount: absolute.sampleCount >= thresholds.minimumSamples,
    pairwiseSampleCount: pairwise.sampleCount >= thresholds.minimumPairwiseSamples,
    verdictAgreement: absolute.verdictAgreement >= thresholds.minimumVerdictAgreement,
    weightedKappa: absolute.weightedKappa >= thresholds.minimumWeightedKappa,
    pairwiseConsistency: pairwise.orderConsistency >= thresholds.minimumPairwiseConsistency,
    positionBias: pairwise.positionBiasRate <= thresholds.maximumPositionBiasRate,
  };
  return {
    schemaVersion: 1 as const,
    datasetVersion: dataset.datasetVersion,
    judgeProvider: dataset.judgeProvider,
    judgeModel: dataset.judgeModel,
    promptVersion: dataset.promptVersion,
    rubricVersion: dataset.rubricVersion,
    thresholds,
    absolute,
    pairwise,
    checks,
    calibrated: Object.values(checks).every(Boolean),
  };
}

export function loadCalibrationDataset(filePath: string): JudgeCalibrationDataset {
  const value = JSON.parse(fs.readFileSync(filePath, "utf-8")) as Partial<JudgeCalibrationDataset>;
  if (value.schemaVersion !== 1 || !value.datasetVersion || !Array.isArray(value.samples) || !Array.isArray(value.pairwiseSamples)) {
    throw new Error(`Invalid Judge calibration dataset: ${filePath}`);
  }
  return value as JudgeCalibrationDataset;
}
