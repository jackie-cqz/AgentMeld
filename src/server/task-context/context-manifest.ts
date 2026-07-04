// ---------------------------------------------------------------------------
// P3: Context Manifest — records what was included and why
// ---------------------------------------------------------------------------

import type { ContextManifestItem } from "@/shared/task-context-types";
import type { ContextCandidate } from "@/server/task-context/context-candidates";
import { candidateToManifestItem } from "@/server/task-context/context-candidates";

export interface ManifestInput {
  included: ContextCandidate[];
  omitted: Array<{ candidate: ContextCandidate; reason: "budget" | "stale" | "unverified" | "unrelated" }>;
}

export function buildContextManifest(input: ManifestInput): ContextManifestItem[] {
  const items: ContextManifestItem[] = [];
  for (const c of input.included) {
    items.push(candidateToManifestItem(c, true));
  }
  for (const o of input.omitted) {
    items.push(candidateToManifestItem(o.candidate, false, o.reason));
  }
  return items;
}

export function manifestSummary(items: ContextManifestItem[]): { includedCount: number; omittedCount: number; byCategory: Record<string, { inc: number; om: number }> } {
  const byCategory: Record<string, { inc: number; om: number }> = {};
  let includedCount = 0;
  let omittedCount = 0;
  for (const item of items) {
    if (!byCategory[item.category]) byCategory[item.category] = { inc: 0, om: 0 };
    if (item.included) { includedCount++; byCategory[item.category].inc++; }
    else { omittedCount++; byCategory[item.category].om++; }
  }
  return { includedCount, omittedCount, byCategory };
}
