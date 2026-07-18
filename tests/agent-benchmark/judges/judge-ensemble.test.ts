import { describe, expect, it } from "vitest";

import type { JudgeResult } from "./judge-types";
import { aggregateJudgeResults } from "./judge-ensemble";

describe("judge ensemble", () => {
  it("uses the median score and stable verdict when samples agree", () => {
    const aggregate = aggregateJudgeResults([
      result(72, "passed", 0.7),
      result(88, "passed", 0.9),
      result(80, "passed", 0.8),
    ]);
    expect(aggregate.disagreement).toBe(false);
    expect(aggregate.result.weightedScore).toBe(80);
    expect(aggregate.result.verdict).toBe("passed");
    expect(aggregate.result.confidence).toBe(0.8);
  });

  it("requires human review when verdicts disagree or a sample is missing", () => {
    const split = aggregateJudgeResults([
      result(80, "passed", 0.8),
      result(60, "failed", 0.6),
    ], 3);
    expect(split.disagreement).toBe(true);
    expect(split.result.verdict).toBe("needs_human_review");
  });
});

function result(score: number, verdict: JudgeResult["verdict"], confidence: number): JudgeResult {
  return {
    schemaVersion: 1,
    provider: "test",
    model: "judge",
    promptVersion: "judge-prompt-v1",
    rubricVersion: "collaboration-v1",
    packetHash: "a".repeat(64),
    dimensions: [{ dimension: "requirement_coverage", score: 3, reason: "Evidence grounded.", evidenceRefs: ["task:r1"] }],
    weightedScore: score,
    verdict,
    confidence,
    summary: verdict,
    tokenUsage: { inputTokens: 10, outputTokens: 5 },
    estimatedCostUsd: 0.01,
    createdAt: 1,
  };
}
