// ---------------------------------------------------------------------------
// P2: Fact Service — canonicalize keys, resolve candidate facts, upsert to DB
// ---------------------------------------------------------------------------

import { getDatabase } from "@/db/client";
import { validateFactValue } from "@/server/context-facts/fact-value-validator";
import { generateCanonicalKey } from "@/server/context-facts/fact-key-generator";
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

  const insertSource = db.prepare(`
    INSERT OR IGNORE INTO conversation_fact_sources (
      id, conversation_id, fact_id, source_type, source_id, source_excerpt, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  // Use transaction for atomic supersede+insert if available
  const runInTransaction = db.transaction
    ? db.transaction(() => {
        runResolutionLoop();
      })
    : null;

  if (runInTransaction) {
    runInTransaction();
  } else {
    runResolutionLoop();
  }

  function runResolutionLoop() {
    for (const candidate of candidates) {
      const { canonicalKey, definitionId, method } = canonicalizeFactKey(candidate, dynamicDefs);

      // No canonical key → requires new definition proposal
      if (!canonicalKey || !definitionId) {
        // P2: Generate a deterministic canonical key for the new definition
        const generatedKey = generateCanonicalKey(
          candidate.entity ?? "unknown",
          candidate.property ?? "value",
          candidate.proposedKey?.split(".").slice(0, -1).join(".")
        );
        resolutions.push({
          status: "pending",
          definitionId: null,
          canonicalKey: generatedKey,
          previousFact: null,
          nextFact: null,
          confidence: candidate.confidence,
          resolutionMethod: "new_definition",
          reason: `No matching definition found — proposed canonical key "${generatedKey}". Requires new definition approval.`,
        });
        continue;
      }

      // Look up current active fact for this key
      const currentActive = activeFacts.find(
        (f) => f.canonicalKey === canonicalKey && f.status === "active"
      );

      // Serialize the candidate value
      const valueJson = JSON.stringify(candidate.value);
      // P2: Use the Definition's declared valueType, not candidate's (prevents bypass)
      const defForType = findBuiltinDefinition(definitionId) ??
        dynamicDefs.find(d => d.id === definitionId);
      const valueType = defForType?.valueType ?? candidate.valueType ?? inferValueType(candidate.value);

      // Check if value is unchanged
      if (currentActive) {
        const currentValue = JSON.stringify(currentActive.value);
        if (currentValue === valueJson) {
          // Same value — no change needed, but record the new source
          const sourceExcerpt = candidate.sourceExcerpt?.slice(0, 500) ?? null;
          insertSource.run(
            `fsrc_${currentActive.id}_${sourceId}`.slice(0, 64),
            conversationId, currentActive.id, sourceType, sourceId, sourceExcerpt, now
          );

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

      // P2: Validate value against the definition's valueType
      const validation = validateFactValue(candidate.value, valueType);
      if (!validation.valid) {
        resolutions.push({
          status: "rejected",
          definitionId,
          canonicalKey,
          previousFact: currentActive ?? null,
          nextFact: null,
          confidence: candidate.confidence,
          resolutionMethod: method,
          reason: `Value validation failed for "${canonicalKey}": ${validation.error}`,
        });
        continue;
      }
      // Use normalized value if available
      const finalValue = validation.normalized ?? candidate.value;

      // Supersede old active fact
      if (currentActive) {
        supersedeFact.run(now, currentActive.id);
      }

      // Insert new fact with validated/normalized value
      const finalValueJson = JSON.stringify(finalValue);
      const factId = `fact_${canonicalKey.replace(/[^a-zA-Z0-9]/g, "_")}_${now}`;
      const trustLevel: EvidenceTrustLevel =
        sourceType === "evidence" ? "verified" :
        sourceType === "user_answer" ? "authoritative" : "reported";

      upsertFact.run(
        factId, conversationId, definitionId, canonicalKey, finalValueJson, valueType,
        "active", trustLevel, candidate.confidence, method,
        sourceType, sourceId,
        currentActive?.id ?? null, now, now
      );

      // P2: Track fact source for audit trail
      const sourceExcerpt = candidate.sourceExcerpt?.slice(0, 500) ?? null;
      insertSource.run(
        `fsrc_${factId}_${sourceId}`.slice(0, 64),
        conversationId, factId, sourceType, sourceId, sourceExcerpt, now
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
          value: finalValue,
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
  } // end runResolutionLoop

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

// ── Definition Management ─────────────────────────────────────────────────

export interface PendingDefinition {
  id: string;
  canonicalKey: string;
  namespace: string;
  entityType: string;
  propertyName: string;
  valueType: string;
  description: string;
  aliases: string[];
  proposedValue: unknown;
  proposedByAgentId: string | null;
  createdAt: number;
}

/** List all pending definition proposals for a conversation */
export function listPendingDefinitions(conversationId: string): PendingDefinition[] {
  const rows = getDatabase()
    .prepare(
      `SELECT * FROM conversation_fact_definitions
       WHERE conversation_id = ? AND status = 'pending'
       ORDER BY created_at ASC`
    )
    .all(conversationId) as Array<Record<string, unknown>>;

  return rows.map((r) => ({
    id: r.id as string,
    canonicalKey: r.canonical_key as string,
    namespace: r.namespace as string,
    entityType: r.entity_type as string,
    propertyName: r.property_name as string,
    valueType: r.value_type as string,
    description: r.description as string,
    aliases: safeJsonParseArray(r.aliases_json as string),
    proposedValue: safeJsonParseValue(r as unknown as { value_json?: string }),
    proposedByAgentId: (r.proposed_by_agent_id as string) ?? null,
    createdAt: r.created_at as number,
  }));
}

/** Approve a pending definition: activate it and create the initial fact */
export function approveDefinition(
  conversationId: string,
  definitionId: string,
  value: unknown
): { canonicalKey: string; factId: string } | { error: string } {
  const db = getDatabase();
  const now = Date.now();

  // Get the pending definition
  const def = db
    .prepare(
      "SELECT * FROM conversation_fact_definitions WHERE id = ? AND conversation_id = ? AND status = 'pending'"
    )
    .get(definitionId, conversationId) as Record<string, unknown> | undefined;

  if (!def) {
    return { error: "Definition not found or not pending." };
  }

  const canonicalKey = def.canonical_key as string;
  const valueType = def.value_type as string;

  // Validate the proposed value
  const validation = validateFactValue(value, valueType as FactDefinition["valueType"]);
  if (!validation.valid) {
    return { error: `Value validation failed: ${validation.error}` };
  }

  const finalValue = validation.normalized ?? value;
  const factId = `fact_${canonicalKey.replace(/[^a-zA-Z0-9]/g, "_")}_${now}`;

  const run = db.transaction
    ? db.transaction(() => applyApproval())
    : applyApproval;

  if (db.transaction) {
    (run as () => void)();
  } else {
    applyApproval();
  }

  return { canonicalKey, factId };

  function applyApproval() {
    // Activate the definition
    db.prepare(
      "UPDATE conversation_fact_definitions SET status = 'active', updated_at = ? WHERE id = ?"
    ).run(now, definitionId);

    // Supersede any existing active fact with the same canonical key
    db.prepare(
      "UPDATE conversation_facts SET status = 'superseded', updated_at = ? WHERE conversation_id = ? AND canonical_key = ? AND status = 'active'"
    ).run(now, conversationId, canonicalKey);

    // Create the initial fact
    db.prepare(`
      INSERT INTO conversation_facts (
        id, conversation_id, definition_id, canonical_key, value_json, value_type,
        status, trust_level, confidence, resolution_method, source_type, source_id,
        supersedes_fact_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      factId, conversationId, definitionId, canonicalKey,
      JSON.stringify(finalValue), valueType,
      "active", "authoritative", 1.0, "manual_confirmation",
      "agent_proposal", definitionId,
      null, now, now
    );
  }
}

/** Reject a pending definition */
export function rejectDefinition(
  conversationId: string,
  definitionId: string
): boolean {
  const result = getDatabase()
    .prepare(
      "UPDATE conversation_fact_definitions SET status = 'rejected', updated_at = ? WHERE id = ? AND conversation_id = ? AND status = 'pending'"
    )
    .run(Date.now(), definitionId, conversationId) as { changes?: number };
  return (result.changes ?? 0) > 0;
}

function safeJsonParseArray(json: string): string[] {
  try { const v = JSON.parse(json); return Array.isArray(v) ? v : []; } catch { return []; }
}

function safeJsonParseValue(row: { value_json?: string }): unknown {
  try {
    if (row.value_json) return JSON.parse(row.value_json);
    // Fallback: try extracting from payload_json or other fields
    return null;
  } catch { return null; }
}
