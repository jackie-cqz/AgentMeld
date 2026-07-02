// ---------------------------------------------------------------------------
// P2: Context Fact types — Fact Registry data model
// ---------------------------------------------------------------------------

import type { EvidenceTrustLevel } from "@/shared/evidence-types";
import type { FactValueType } from "@/shared/builtin-fact-definitions";

export interface ConversationFact {
  id: string;
  conversationId: string;
  definitionId: string;
  canonicalKey: string;
  value: unknown;
  valueType: FactValueType;
  status: "active" | "superseded" | "pending" | "rejected";
  trustLevel: EvidenceTrustLevel;
  confidence: number;
  resolutionMethod:
    | "definition_id"
    | "canonical_key"
    | "alias"
    | "entity_property"
    | "new_definition"
    | "manual_confirmation";
  sourceType: "message" | "user_answer" | "evidence" | "agent_proposal";
  sourceId: string;
  supersedesFactId: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface CandidateFactUpdate {
  definitionId?: string;
  proposedKey?: string;
  entity?: string;
  property?: string;
  value: unknown;
  valueType?: FactValueType;
  confidence: number;
  sourceExcerpt?: string;
}

export interface CandidateFactDefinition {
  proposedNamespace?: string;
  entity: string;
  property: string;
  value: unknown;
  valueType: FactValueType;
  description: string;
  aliases?: string[];
  confidence: number;
  sourceExcerpt?: string;
}

export interface FactResolution {
  status: "matched" | "created" | "pending" | "no_change" | "rejected";
  definitionId: string | null;
  canonicalKey: string | null;
  previousFact: ConversationFact | null;
  nextFact: ConversationFact | null;
  confidence: number;
  resolutionMethod: ConversationFact["resolutionMethod"] | null;
  reason: string;
}

export interface FactResolutionResult {
  resolutions: FactResolution[];
  summary: string;
}
