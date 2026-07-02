// ---------------------------------------------------------------------------
// P2: Fact Service — canonicalize keys, resolve candidate facts, upsert to DB
// ---------------------------------------------------------------------------

import { getDatabase } from "@/db/client";
import { newMessageId } from "@/shared/ids";
import {
  BUILTIN_FACT_DEFINITIONS,
  findBuiltinDefinition,
  type FactDefinition,
} from "@/shared/builtin-fact-definitions";
import type { EvidenceTrustLevel } from "@/shared/evidence-types";
import type {
  CandidateFactUpdate,
  CandidateFactDefinition,
  ConversationFact,
  FactResolution,
  FactResolutionResult,
} from "@/shared/context-fact-types";

// ── Canonicalizer ──────────────────────────────────────────────────────────

/**
 * Resolve the canonical key for a candidate fact update.
 * Priority: definitionId → canonical_key → alias → entity_property match → unknown
 */
export function canonicalizeFactKey(
  candidate: CandidateFactUpdate,
  conversationDynamicDefs: FactDefinition[]
): { canonicalKey: string | null; definitionId: string | null; method: FactResolution["resolutionMethod"] } {
  // 1. Candidate provided a definitionId — look up builtin + dynamic
  if (candidate.definitionId) {
    const def = findBuiltinDefinition(candidate.definitionId) ??
      conversationDynamicDefs.find((d) => d.id === candidate.definitionId);
    if (def) {
      return { canonicalKey: def.canonicalKey, definitionId: def.id, method: "definition_id" };
    }
  }

  // 2. Candidate provided a proposedKey — try as canonical key directly
  if (candidate.proposedKey) {
    const builtin = BUILTIN_FACT_DEFINITIONS.find(
      (d) => d.canonicalKey === candidate.proposedKey
    );
    if (builtin) {
      return { canonicalKey: builtin.canonicalKey, definitionId: builtin.id, method: "canonical_key" };
    }
    const dynamic = conversationDynamicDefs.find(
      (d) => d.canonicalKey === candidate.proposedKey
    );
    if (dynamic) {
      return { canonicalKey: dynamic.canonicalKey, definitionId: dynamic.id, method: "canonical_key" };
    }
  }

  // 3. Candidate provided a proposedKey — try as alias match
  if (candidate.proposedKey) {
    const builtinByAlias = findBuiltinDefinition(candidate.proposedKey);
    if (builtinByAlias) {
      return { canonicalKey: builtinByAlias.canonicalKey, definitionId: builtinByAlias.id, method: "alias" };
    }
    const dynamicByAlias = conversationDynamicDefs.find(
      (d) => d.aliases?.some((a) => a.toLowerCase() === candidate.proposedKey!.toLowerCase())
    );
    if (dynamicByAlias) {
      return { canonicalKey: dynamicByAlias.canonicalKey, definitionId: dynamicByAlias.id, method: "alias" };
    }
  }

  // 4. Entity + property match (for new definitions)
  if (candidate.entity && candidate.property) {
    const builtinByEP = BUILTIN_FACT_DEFINITIONS.find(
      (d) =>
        d.entityType === candidate.entity && d.property === candidate.property
    );
    if (builtinByEP) {
      return { canonicalKey: builtinByEP.canonicalKey, definitionId: builtinByEP.id, method: "entity_property" };
    }
    const dynamicByEP = conversationDynamicDefs.find(
      (d) =>
        d.entityType === candidate.entity && d.property === candidate.property
    );
    if (dynamicByEP) {
      return { canonicalKey: dynamicByEP.canonicalKey, definitionId: dynamicByEP.id, method: "entity_property" };
    }
  }

  // 5. No match — requires new definition
  return { canonicalKey: null, definitionId: null, method: "new_definition" };
}

// ── Fact Resolution ────────────────────────────────────────────────────────

/**
 * Process a batch of candidate fact updates against the current active facts
 * and produce a resolution result. Applies updates in a SQLite transaction.
 */
export function resolveFacts(
  conversationId: string,
  candidates: CandidateFactUpdate[],
  sourceType: ConversationFact["sourceType"],
  sourceId: string
): FactResolutionResult {
  const db = getDatabase();
  const now = Date.now();
  const resolutions: FactResolution[] = [];

  // Load current active facts for this conversation
  const activeFacts = loadActiveFacts(conversationId);

  // Load dynamic definitions
  const dynamicDefs = loadDynamicDefinitions(conversationId);

  const upsertFact = db.prepare(`
    INSERT INTO conversation_facts (
      id, conversation_id, definition_id, canonical_key, value_json, value_type,
      status, trust_level, confidence, resolution_method, source_type, source_id,
      supersedes_fact_id, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const supersedeFact = db.prepare(`
    UPDATE conversation_facts SET status = 'superseded', updated_at = ?
    WHERE id = ? AND status = 'active'
  `);

  // Run sequentially (P2: transaction wrapper deferred until SQLite adapter supports it)
    for (const candidate of candidates) {
      const { canonicalKey, definitionId, method } = canonicalizeFactKey(candidate, dynamicDefs);

      // No canonical key → requires new definition proposal
      if (!canonicalKey || !definitionId) {
        resolutions.push({
          status: "pending",
          definitionId: null,
          canonicalKey: candidate.proposedKey ?? null,
          previousFact: null,
          nextFact: null,
          confidence: candidate.confidence,
          resolutionMethod: "new_definition",
          reason: `No matching definition found for "${candidate.proposedKey ?? candidate.entity + "." + candidate.property}". Requires new definition proposal.`,
        });
        continue;
      }

      // Look up current active fact for this key
      const currentActive = activeFacts.find(
        (f) => f.canonicalKey === canonicalKey && f.status === "active"
      );

      // Serialize the candidate value
      const valueJson = JSON.stringify(candidate.value);
      const valueType = candidate.valueType ?? inferValueType(candidate.value);

      // Check if value is unchanged
      if (currentActive) {
        const currentValue = JSON.stringify(currentActive.value);
        if (currentValue === valueJson) {
          // Same value — no change needed
          resolutions.push({
            status: "no_change",
            definitionId,
            canonicalKey,
            previousFact: currentActive,
            nextFact: currentActive,
            confidence: candidate.confidence,
            resolutionMethod: method,
            reason: `Value unchanged for "${canonicalKey}" — same as current.`,
          });
          continue;
        }
      }

      // Low confidence — don't auto-apply
      if (candidate.confidence < 0.7) {
        resolutions.push({
          status: "pending",
          definitionId,
          canonicalKey,
          previousFact: currentActive ?? null,
          nextFact: null,
          confidence: candidate.confidence,
          resolutionMethod: method,
          reason: `Low confidence (${candidate.confidence.toFixed(2)}) for "${canonicalKey}" — requires manual confirmation.`,
        });
        continue;
      }

      // Supersede old active fact
      if (currentActive) {
        supersedeFact.run(now, currentActive.id);
      }

      // Insert new fact
      const factId = `fact_${canonicalKey.replace(/[^a-zA-Z0-9]/g, "_")}_${now}`;
      const trustLevel: EvidenceTrustLevel =
        sourceType === "evidence" ? "verified" :
        sourceType === "user_answer" ? "authoritative" : "reported";

      upsertFact.run(
        factId, conversationId, definitionId, canonicalKey, valueJson, valueType,
        "active", trustLevel, candidate.confidence, method,
        sourceType, sourceId,
        currentActive?.id ?? null, now, now
      );

      resolutions.push({
        status: currentActive ? "matched" : "created",
        definitionId,
        canonicalKey,
        previousFact: currentActive ?? null,
        nextFact: {
          id: factId,
          conversationId,
          definitionId,
          canonicalKey,
          value: candidate.value,
          valueType,
          status: "active",
          trustLevel,
          confidence: candidate.confidence,
          resolutionMethod: method as ConversationFact["resolutionMethod"],
          sourceType,
          sourceId,
          supersedesFactId: currentActive?.id ?? null,
          createdAt: now,
          updatedAt: now,
        },
        confidence: candidate.confidence,
        resolutionMethod: method,
        reason: currentActive
          ? `Updated "${canonicalKey}" — superseded previous value.`
          : `Created new fact "${canonicalKey}".`,
      });
    }

  return {
    resolutions,
    summary: buildResolutionSummary(resolutions),
  };
}

// ── Queries ────────────────────────────────────────────────────────────────

export function loadActiveFacts(conversationId: string): ConversationFact[] {
  const rows = getDatabase()
    .prepare(
      "SELECT * FROM conversation_facts WHERE conversation_id = ? AND status = 'active'"
    )
    .all(conversationId) as Array<Record<string, unknown>>;

  return rows.map(mapFactRow);
}

export function loadDynamicDefinitions(conversationId: string): FactDefinition[] {
  const rows = getDatabase()
    .prepare(
      "SELECT * FROM conversation_fact_definitions WHERE conversation_id = ? AND status IN ('active', 'pending')"
    )
    .all(conversationId) as Array<Record<string, unknown>>;

  return rows.map((r) => ({
    id: r.id as string,
    canonicalKey: r.canonical_key as string,
    namespace: r.namespace as string,
    entityType: r.entity_type as string,
    property: r.property_name as string,
    valueType: r.value_type as FactDefinition["valueType"],
    updatePolicy: (r.update_policy as FactDefinition["updatePolicy"]) ?? "replace",
    description: r.description as string,
    aliases: safeJsonParse(r.aliases_json as string, []) as string[],
    applicableTaskTags: safeJsonParse(r.applicable_task_tags_json as string, []) as string[],
    applicableAgentRoles: safeJsonParse(r.applicable_agent_roles_json as string, []) as string[],
    origin: (r.origin as "builtin" | "conversation") ?? "conversation",
  }));
}

// ── Helpers ────────────────────────────────────────────────────────────────

function mapFactRow(r: Record<string, unknown>): ConversationFact {
  return {
    id: r.id as string,
    conversationId: r.conversation_id as string,
    definitionId: r.definition_id as string,
    canonicalKey: r.canonical_key as string,
    value: parseValue(r.value_json as string),
    valueType: r.value_type as ConversationFact["valueType"],
    status: r.status as ConversationFact["status"],
    trustLevel: r.trust_level as ConversationFact["trustLevel"],
    confidence: r.confidence as number,
    resolutionMethod: r.resolution_method as ConversationFact["resolutionMethod"],
    sourceType: r.source_type as ConversationFact["sourceType"],
    sourceId: r.source_id as string,
    supersedesFactId: (r.supersedes_fact_id as string) ?? null,
    createdAt: r.created_at as number,
    updatedAt: r.updated_at as number,
  };
}

function inferValueType(value: unknown): ConversationFact["valueType"] {
  if (typeof value === "string") {
    if (/^#[0-9a-fA-F]{3,8}$/.test(value)) return "color";
    return "string";
  }
  if (typeof value === "number") return "number";
  if (typeof value === "boolean") return "boolean";
  if (Array.isArray(value)) return "string_array";
  return "json";
}

function parseValue(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    return json;
  }
}

function safeJsonParse(json: string, fallback: unknown): unknown {
  try {
    return JSON.parse(json);
  } catch {
    return fallback;
  }
}

function buildResolutionSummary(resolutions: FactResolution[]): string {
  const created = resolutions.filter((r) => r.status === "created").length;
  const matched = resolutions.filter((r) => r.status === "matched").length;
  const pending = resolutions.filter((r) => r.status === "pending").length;
  const unchanged = resolutions.filter((r) => r.status === "no_change").length;
  const parts: string[] = [];
  if (created > 0) parts.push(`${created} facts created`);
  if (matched > 0) parts.push(`${matched} facts updated`);
  if (unchanged > 0) parts.push(`${unchanged} facts unchanged`);
  if (pending > 0) parts.push(`${pending} facts pending review`);
  return parts.join(", ") || "No facts changed";
}
