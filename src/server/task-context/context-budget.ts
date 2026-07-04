// ---------------------------------------------------------------------------
// P3: Context Token Budget
// ---------------------------------------------------------------------------

import type { ContextCandidate } from "@/server/task-context/context-candidates";
import type { TierClassification } from "@/server/task-context/context-policy";

export interface TaskContextTokenBudget {
  maxInputTokens: number;
  requiredTokens: number;
  optionalTokens: number;
  omittedTokens: number;
}

const DEFAULT_CONTEXT_WINDOW = 64000;

/**
 * Compute the available task context budget.
 * = contextWindow - systemPrompt - toolSchemas - taskInstruction - outputReserve - protocolMargin
 */
export function computeBudget(
  _modelProvider: string | null | undefined,
  systemPromptTokens: number,
  toolSchemaTokens: number,
  taskInstructionTokens: number
): number {
  // P3: Use a fixed default for model-agnostic compilation; P8 can add model-specific lookup
  const contextWindow = DEFAULT_CONTEXT_WINDOW;
  const outputReserve = 4096;
  const protocolMargin = 512;
  return Math.max(0, contextWindow - systemPromptTokens - toolSchemaTokens - taskInstructionTokens - outputReserve - protocolMargin);
}

/**
 * Allocate budget to candidates by tier.
 * - Mandatory: always included (if over budget → task_context_overflow)
 * - High: 60% of remaining after mandatory
 * - Optional: 40% of remaining after mandatory
 * Returns the packed set and a manifest of omitted items.
 */
export function allocateBudget(
  candidates: Array<{ candidate: ContextCandidate; tier: TierClassification; rank: number }>,
  availableBudget: number
): { packed: ContextCandidate[]; omitted: Array<{ candidate: ContextCandidate; reason: "budget" | "stale" | "unverified" | "unrelated" }> } {
  const mandatory = candidates.filter(c => c.tier.tier === "mandatory");
  const high = candidates.filter(c => c.tier.tier === "high").sort((a, b) => b.rank - a.rank);
  const optional = candidates.filter(c => c.tier.tier === "optional").sort((a, b) => b.rank - a.rank);
  const forbidden = candidates.filter(c => c.tier.tier === "forbidden");

  const packed: ContextCandidate[] = [];
  const omitted: Array<{ candidate: ContextCandidate; reason: "budget" | "stale" | "unverified" | "unrelated" }> = [];

  // Forbidden
  for (const f of forbidden) {
    omitted.push({ candidate: f.candidate, reason: "unverified" });
  }

  // Mandatory
  let usedTokens = 0;
  for (const m of mandatory) {
    usedTokens += m.candidate.tokenEstimate;
    packed.push(m.candidate);
  }

  if (usedTokens > availableBudget) {
    // Mandatory exceeds budget — task_context_overflow
    return { packed, omitted: [...omitted, ...high.map(h => ({ candidate: h.candidate, reason: "budget" as const })), ...optional.map(o => ({ candidate: o.candidate, reason: "budget" as const }))] };
  }

  // High (60% of remaining)
  const remaining = availableBudget - usedTokens;
  const highBudget = Math.floor(remaining * 0.6);
  for (const h of high) {
    if (usedTokens + h.candidate.tokenEstimate <= availableBudget && h.candidate.tokenEstimate <= highBudget + usedTokens - usedTokens) {
      // Simple greedy: include if within remaining
    }
    if (usedTokens + h.candidate.tokenEstimate <= availableBudget - Math.floor(remaining * 0.4)) {
      usedTokens += h.candidate.tokenEstimate;
      packed.push(h.candidate);
    } else {
      omitted.push({ candidate: h.candidate, reason: "budget" });
    }
  }

  // Optional (40% of remaining, fill up)
  for (const o of optional) {
    if (usedTokens + o.candidate.tokenEstimate <= availableBudget) {
      usedTokens += o.candidate.tokenEstimate;
      packed.push(o.candidate);
    } else {
      omitted.push({ candidate: o.candidate, reason: "budget" });
    }
  }

  return { packed, omitted };
}

/** Check if mandatory content exceeds budget → task_context_overflow */
export function isMandatoryOverBudget(mandatoryTokens: number, availableBudget: number): boolean {
  return mandatoryTokens > availableBudget;
}
