// ---------------------------------------------------------------------------
// P3: Token Budget Packer — greedy section-based packing per §9.3.6
// ---------------------------------------------------------------------------

import type { ContextCandidate } from "@/server/task-context/context-candidates";
import type { ScoredCandidate } from "@/server/task-context/relevance-ranker";
import type { TaskContextTokenBudget } from "@/server/task-context/context-budget";

export interface PackedTaskContext {
  packed: ContextCandidate[];
  omitted: Array<{ candidate: ContextCandidate; reason: "budget" | "stale" | "unverified" | "unrelated" }>;
  budget: TaskContextTokenBudget;
}

/**
 * Greedy packing per §9.3.6:
 * 1. Mandatory first (overflow → fail)
 * 2. High: 60% of remaining
 * 3. Optional: remaining
 */
export function packContext(
  scored: ScoredCandidate[],
  availableBudget: number
): PackedTaskContext {
  const mandatory = scored.filter(s => s.tier.tier === "mandatory");
  const high = scored.filter(s => s.tier.tier === "high").sort((a, b) => b.score - a.score);
  const optional = scored.filter(s => s.tier.tier === "optional").sort((a, b) => b.score / Math.max(1, a.candidate.tokenEstimate) - a.score / Math.max(1, b.candidate.tokenEstimate));
  const forbidden = scored.filter(s => s.tier.tier === "forbidden");

  const packed: ContextCandidate[] = [];
  const omitted: PackedTaskContext["omitted"] = [];
  let usedTokens = 0;

  for (const f of forbidden) {
    omitted.push({ candidate: f.candidate, reason: "unverified" });
  }

  const mandatoryTokens = mandatory.reduce((s, m) => s + m.candidate.tokenEstimate, 0);
  if (mandatoryTokens > availableBudget) {
    return {
      packed: mandatory.map(m => m.candidate),
      omitted: [...omitted, ...high.map(h => ({ candidate: h.candidate, reason: "budget" as const })), ...optional.map(o => ({ candidate: o.candidate, reason: "budget" as const }))],
      budget: { maxInputTokens: availableBudget, requiredTokens: mandatoryTokens, optionalTokens: 0, omittedTokens: mandatoryTokens - availableBudget },
    };
  }

  for (const m of mandatory) { usedTokens += m.candidate.tokenEstimate; packed.push(m.candidate); }
  const remaining = availableBudget - usedTokens;
  const highBudget = Math.floor(remaining * 0.6);

  let highUsed = 0;
  for (const h of high) {
    if (highUsed + h.candidate.tokenEstimate <= highBudget) {
      highUsed += h.candidate.tokenEstimate;
      packed.push(h.candidate);
    } else {
      omitted.push({ candidate: h.candidate, reason: "budget" });
    }
  }

  for (const o of optional) {
    if (usedTokens + highUsed + o.candidate.tokenEstimate <= availableBudget) {
      packed.push(o.candidate);
      usedTokens += o.candidate.tokenEstimate;
    } else {
      omitted.push({ candidate: o.candidate, reason: "budget" });
    }
  }

  return {
    packed,
    omitted,
    budget: {
      maxInputTokens: availableBudget,
      requiredTokens: mandatoryTokens,
      optionalTokens: packed.filter(p => !mandatory.some(m => m.candidate.id === p.id)).reduce((s, p) => s + p.tokenEstimate, 0),
      omittedTokens: omitted.reduce((s, o) => s + o.candidate.tokenEstimate, 0),
    },
  };
}
