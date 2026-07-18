import { hashCanonical } from "./judge-packet-builder";
import type { JudgePacket } from "./judge-types";

export interface PairwiseJudgePacket {
  schemaVersion: 1;
  pairHash: string;
  caseId: string;
  candidates: Array<{ label: "A" | "B"; packet: JudgePacket }>;
}

export interface PairwiseJudgeBundle {
  packet: PairwiseJudgePacket;
  hiddenOrder: { A: "baseline" | "candidate"; B: "baseline" | "candidate" };
}

export interface PairwiseJudgeResult {
  schemaVersion: 1;
  pairHash: string;
  winner: "A" | "B" | "tie";
  confidence: number;
  rationale: string;
  evidenceRefs: Array<{ candidate: "A" | "B"; ref: string }>;
}

export interface PairwiseConsistencyResult {
  consistent: boolean;
  positionBiasDetected: boolean;
  forwardWinner: "baseline" | "candidate" | "tie";
  reverseWinner: "baseline" | "candidate" | "tie";
}

export function buildPairwiseJudgePacket(
  baseline: JudgePacket,
  candidate: JudgePacket,
  swap = false,
): PairwiseJudgeBundle {
  if (baseline.caseId !== candidate.caseId) throw new Error("Pairwise judge packets must use the same case.");
  const candidates = swap
    ? [{ label: "A" as const, packet: candidate }, { label: "B" as const, packet: baseline }]
    : [{ label: "A" as const, packet: baseline }, { label: "B" as const, packet: candidate }];
  const hiddenOrder = swap
    ? { A: "candidate" as const, B: "baseline" as const }
    : { A: "baseline" as const, B: "candidate" as const };
  const body = { schemaVersion: 1 as const, caseId: baseline.caseId, candidates };
  return { packet: { ...body, pairHash: hashCanonical(body) }, hiddenOrder };
}

export function parsePairwiseJudgeResult(
  packet: PairwiseJudgePacket,
  value: unknown,
): PairwiseJudgeResult {
  if (!value || typeof value !== "object") throw new Error("Pairwise judge result must be an object.");
  const result = value as Partial<PairwiseJudgeResult>;
  if (result.schemaVersion !== 1) throw new Error("Pairwise judge result schemaVersion must be 1.");
  if (result.pairHash !== packet.pairHash) throw new Error("Pairwise judge result pairHash does not match packet.");
  if (result.winner !== "A" && result.winner !== "B" && result.winner !== "tie") {
    throw new Error("Pairwise judge winner must be A, B, or tie.");
  }
  if (typeof result.confidence !== "number" || result.confidence < 0 || result.confidence > 1) {
    throw new Error("Pairwise judge confidence must be between 0 and 1.");
  }
  if (typeof result.rationale !== "string" || !result.rationale.trim()) {
    throw new Error("Pairwise judge rationale is required.");
  }
  if (!Array.isArray(result.evidenceRefs) || result.evidenceRefs.length === 0) {
    throw new Error("Pairwise judge evidenceRefs are required.");
  }
  const allowedByLabel = new Map(packet.candidates.map((candidate) => [
    candidate.label,
    new Set(candidate.packet.evidenceReferences.map((reference) => reference.id)),
  ]));
  for (const reference of result.evidenceRefs) {
    if (!reference || (reference.candidate !== "A" && reference.candidate !== "B") || typeof reference.ref !== "string") {
      throw new Error("Pairwise judge evidence reference is invalid.");
    }
    if (!allowedByLabel.get(reference.candidate)?.has(reference.ref)) {
      throw new Error(`Pairwise judge references unknown evidence: ${reference.candidate}:${reference.ref}`);
    }
  }
  return result as PairwiseJudgeResult;
}

export function evaluatePairwiseSwapConsistency(
  forward: { result: PairwiseJudgeResult; hiddenOrder: PairwiseJudgeBundle["hiddenOrder"] },
  reverse: { result: PairwiseJudgeResult; hiddenOrder: PairwiseJudgeBundle["hiddenOrder"] },
): PairwiseConsistencyResult {
  const forwardWinner = revealWinner(forward.result.winner, forward.hiddenOrder);
  const reverseWinner = revealWinner(reverse.result.winner, reverse.hiddenOrder);
  return {
    consistent: forwardWinner === reverseWinner,
    positionBiasDetected: forwardWinner !== reverseWinner
      && forward.result.winner !== "tie"
      && forward.result.winner === reverse.result.winner,
    forwardWinner,
    reverseWinner,
  };
}

function revealWinner(
  winner: PairwiseJudgeResult["winner"],
  hiddenOrder: PairwiseJudgeBundle["hiddenOrder"],
): "baseline" | "candidate" | "tie" {
  return winner === "tie" ? "tie" : hiddenOrder[winner];
}
