import { describe, expect, it } from "vitest";

import type { JudgePacket } from "./judge-types";
import {
  buildPairwiseJudgePacket,
  evaluatePairwiseSwapConsistency,
  parsePairwiseJudgeResult,
} from "./pairwise-judge";

describe("pairwise judge", () => {
  it("keeps baseline identity outside the judge-visible packet", () => {
    const bundle = buildPairwiseJudgePacket(packet("a"), packet("b"));
    expect(JSON.stringify(bundle.packet)).not.toMatch(/"baseline"|"candidate"/);
    expect(bundle.hiddenOrder).toEqual({ A: "baseline", B: "candidate" });
  });

  it("validates references and detects consistent winners after swapping", () => {
    const forward = buildPairwiseJudgePacket(packet("a"), packet("b"));
    const reverse = buildPairwiseJudgePacket(packet("a"), packet("b"), true);
    const forwardResult = parsePairwiseJudgeResult(forward.packet, result(forward.packet.pairHash, "B", "ref-b"));
    const reverseResult = parsePairwiseJudgeResult(reverse.packet, result(reverse.packet.pairHash, "A", "ref-b"));
    expect(evaluatePairwiseSwapConsistency(
      { result: forwardResult, hiddenOrder: forward.hiddenOrder },
      { result: reverseResult, hiddenOrder: reverse.hiddenOrder },
    )).toEqual({
      consistent: true,
      positionBiasDetected: false,
      forwardWinner: "candidate",
      reverseWinner: "candidate",
    });
  });

  it("flags a judge that always selects the first position", () => {
    const forward = buildPairwiseJudgePacket(packet("a"), packet("b"));
    const reverse = buildPairwiseJudgePacket(packet("a"), packet("b"), true);
    const forwardResult = parsePairwiseJudgeResult(forward.packet, result(forward.packet.pairHash, "A", "ref-a"));
    const reverseResult = parsePairwiseJudgeResult(reverse.packet, result(reverse.packet.pairHash, "A", "ref-b"));
    expect(evaluatePairwiseSwapConsistency(
      { result: forwardResult, hiddenOrder: forward.hiddenOrder },
      { result: reverseResult, hiddenOrder: reverse.hiddenOrder },
    ).positionBiasDetected).toBe(true);
  });

  it("rejects evidence not present in the selected candidate packet", () => {
    const bundle = buildPairwiseJudgePacket(packet("a"), packet("b"));
    expect(() => parsePairwiseJudgeResult(
      bundle.packet,
      result(bundle.packet.pairHash, "A", "ref-not-present"),
    )).toThrow("unknown evidence");
  });
});

function packet(suffix: string): JudgePacket {
  return {
    schemaVersion: 1,
    packetHash: suffix.repeat(64),
    caseId: "same-case",
    title: `Option ${suffix}`,
    prompt: "Build the requested application.",
    expectedRoles: ["frontend"],
    deterministicAssertions: [],
    tasks: [],
    artifacts: [],
    runtime: {},
    evidenceReferences: [{ id: `ref-${suffix}`, kind: "artifact", label: `Artifact ${suffix}` }],
    securityNotice: "Untrusted data.",
  };
}

function result(pairHash: string, winner: "A" | "B", ref: string) {
  return {
    schemaVersion: 1,
    pairHash,
    winner,
    confidence: 0.9,
    rationale: "The selected option better satisfies the rubric.",
    evidenceRefs: [{ candidate: winner, ref }],
  };
}
