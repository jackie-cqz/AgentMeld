// ---------------------------------------------------------------------------
// P3: Relevance Ranker — V1 rule-based scoring, no LLM/embedding
// ---------------------------------------------------------------------------

import type { ContextCandidate } from "@/server/task-context/context-candidates";
import type { TierClassification } from "@/server/task-context/context-policy";

export interface ScoredCandidate {
  candidate: ContextCandidate;
  tier: TierClassification;
  score: number;
  scoreReasons: string[];
}

/**
 * Score a qualified candidate by deterministic rules per §9.3.3.
 * High scores = more likely to be included when budget is tight.
 */
export function scoreCandidate(
  candidate: ContextCandidate,
  tier: TierClassification,
  context: { taskId: string; dagDepTaskIds: string[]; targetPaths: string[] }
): ScoredCandidate {
  const reasons: string[] = [];
  let score = 0;

  // Base weights per §9.3.3
  if (candidate.required) { score += 1000; reasons.push("required +1000"); }
  if (candidate.category === "task") { score += 900; reasons.push("current task +900"); }
  if (candidate.category === "fact" && candidate.required) { score += 850; reasons.push("required fact +850"); }
  if (candidate.category === "upstream_input" && candidate.taskIds.some(id => context.dagDepTaskIds.includes(id))) {
    score += 800; reasons.push("direct verified input +800");
  }
  if (candidate.criterionIds.length > 0) { score += 800; reasons.push("acceptance criterion +800"); }
  if (candidate.category === "failure") { score += 780; reasons.push("failure context +780"); }
  if (candidate.pathRefs.some(p => context.targetPaths.includes(p))) { score += 650; reasons.push("target path match +650"); }
  if (candidate.category === "evidence" && candidate.criterionIds.length > 0) { score += 620; reasons.push("criterion evidence +620"); }
  if (candidate.category === "fact" && candidate.namespaces.length > 0) { score += 550; reasons.push("namespace fact +550"); }
  if (candidate.trustLevel === "verified" || candidate.trustLevel === "authoritative") { score += 500; reasons.push("verified upstream +500"); }
  if (candidate.category === "recent_message") { score += 300; reasons.push("recent message +300"); }
  if (candidate.category === "retrieved_history") { score += 150; reasons.push("retrieved history +150"); }
  if (candidate.category === "workspace") { score += 80; reasons.push("reference metadata +80"); }

  return { candidate, tier, score, scoreReasons: reasons };
}

export function rankCandidates(
  scored: ScoredCandidate[]
): ScoredCandidate[] {
  return [...scored].sort((a, b) => b.score - a.score);
}
