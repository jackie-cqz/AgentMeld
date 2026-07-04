// ---------------------------------------------------------------------------
// P3: Context Candidates — collectors that produce ContextCandidate items
// ---------------------------------------------------------------------------

import type { EvidenceTrustLevel } from "@/shared/evidence-types";
import type { ContextManifestItem } from "@/shared/task-context-types";

export type CandidateCategory =
  | "task" | "fact" | "upstream_input" | "workspace"
  | "evidence" | "failure" | "recent_message" | "retrieved_history";

export interface ContextCandidate {
  id: string;
  category: CandidateCategory;
  sourceType: string;
  sourceId: string;
  content: unknown;
  trustLevel: EvidenceTrustLevel;
  required: boolean;
  /** Which task IDs this candidate is relevant to */
  taskIds: string[];
  /** Fact namespaces this candidate belongs to */
  namespaces: string[];
  /** File paths referenced */
  pathRefs: string[];
  /** Criterion IDs this candidate supports */
  criterionIds: string[];
  tokenEstimate: number;
  createdAt: number;
}

export function candidateToManifestItem(c: ContextCandidate, included: boolean, omittedReason?: ContextManifestItem["omittedReason"]): ContextManifestItem {
  return {
    id: c.id,
    category: c.category,
    sourceType: c.sourceType,
    sourceId: c.sourceId,
    reason: c.sourceType,
    required: c.required,
    trustLevel: c.trustLevel,
    tokenEstimate: c.tokenEstimate,
    included,
    omittedReason: included ? null : (omittedReason ?? "unrelated"),
  };
}
