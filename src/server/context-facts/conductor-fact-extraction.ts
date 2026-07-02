// ---------------------------------------------------------------------------
// P2: Conductor fact extraction — extract structured facts from user messages
// ---------------------------------------------------------------------------

import type { Agent, Message } from "@/shared/types";
import {
  BUILTIN_FACT_DEFINITIONS,
  type FactDefinition,
} from "@/shared/builtin-fact-definitions";
import { resolveFacts, loadActiveFacts, loadDynamicDefinitions } from "@/server/context-facts/fact-service";
import type {
  CandidateFactUpdate,
  FactResolutionResult,
} from "@/shared/context-fact-types";

/**
 * Extract facts from a user turn by having the Conductor LLM analyze
 * the message and propose structured fact updates. Falls back to simple
 * key-value extraction if LLM is unavailable.
 */
export async function extractFactsForUserTurn(input: {
  conversationId: string;
  conductorRunId: string;
  conductorAgent: Agent;
  triggerMessage: Message;
}): Promise<FactResolutionResult> {
  const { conversationId, triggerMessage } = input;
  const userText = extractTextFromMessage(triggerMessage);

  // Skip trivial messages
  if (isTrivialMessage(userText)) {
    return { resolutions: [], summary: "Trivial message — skipped fact extraction." };
  }

  // Build the fact extraction prompt context
  const activeFacts = loadActiveFacts(conversationId);
  const dynamicDefs = loadDynamicDefinitions(conversationId);
  const relevantDefs = filterRelevantDefinitions(BUILTIN_FACT_DEFINITIONS, dynamicDefs, userText);

  // Parse candidate facts from the user message using simple heuristics
  // (full LLM-driven extraction requires the conductor Adapter, landed later)
  const candidates = extractCandidatesHeuristic(userText, relevantDefs, activeFacts);

  if (candidates.length === 0) {
    return { resolutions: [], summary: "No fact candidates detected in message." };
  }

  // Resolve and persist
  return resolveFacts(
    conversationId,
    candidates.slice(0, 20), // Cap at 20 per turn
    "message",
    triggerMessage.id
  );
}

// ── Helpers ────────────────────────────────────────────────────────────────

function extractTextFromMessage(msg: Message): string {
  return msg.parts
    .filter((p) => p.type === "text")
    .map((p) => p.content)
    .join("\n");
}

function isTrivialMessage(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length < 5) return true;
  const trivialPatterns = /^(你好|谢谢|好的|ok|嗯|哦|hi|hello|thanks|bye|再见)[!！。.]*$/i;
  return trivialPatterns.test(trimmed);
}

interface RelevantDef {
  definition: FactDefinition;
  currentValue: unknown | null;
}

function filterRelevantDefinitions(
  builtin: FactDefinition[],
  dynamic: FactDefinition[],
  userText: string
): FactDefinition[] {
  // Simple relevance: match definition description keywords against user text
  const lower = userText.toLowerCase();
  const all = [...builtin, ...dynamic];
  return all.filter(
    (d) =>
      d.aliases.some((a) => lower.includes(a.toLowerCase())) ||
      d.description.split("").some((_c, i) => {
        const word = d.description.slice(i, i + 4);
        return word.length >= 2 && lower.includes(word.toLowerCase());
      }) ||
      lower.includes(d.property.toLowerCase()) ||
      lower.includes(d.entityType.toLowerCase())
  );
}

/**
 * Heuristic fact extraction using keyword matching.
 * In production, this would be replaced by LLM-driven extraction via
 * the Conductor adapter. The heuristic serves as a fast fallback.
 */
function extractCandidatesHeuristic(
  userText: string,
  relevantDefs: FactDefinition[],
  _activeFacts: ConversationFact[]
): CandidateFactUpdate[] {
  const candidates: CandidateFactUpdate[] = [];

  // Color extraction: #xxxxxx pattern
  const colorMatch = userText.match(/#[0-9a-fA-F]{3,8}/);
  if (colorMatch) {
    const colorDefs = relevantDefs.filter((d) => d.valueType === "color");
    for (const def of colorDefs) {
      candidates.push({
        definitionId: def.id,
        value: colorMatch[0],
        valueType: "color",
        confidence: 0.85,
        sourceExcerpt: userText.slice(Math.max(0, userText.indexOf(colorMatch[0]) - 20), userText.indexOf(colorMatch[0]) + 30),
      });
    }
  }

  // Boolean extraction: "需要/不需要/要/不要" patterns
  const needsMatch = userText.match(/(?:需要|要求|必须|要|不要|不需要)\s*(.{1,10})/g);
  if (needsMatch) {
    const boolDefs = relevantDefs.filter(
      (d) =>
        d.valueType === "boolean" &&
        needsMatch.some((m) => m.includes(d.property) || d.aliases.some((a) => m.includes(a)))
    );
    for (const def of boolDefs) {
      const isPositive = needsMatch.some((m) => /(?:需要|要求|必须|要)(?!不)/.test(m));
      candidates.push({
        definitionId: def.id,
        value: isPositive,
        valueType: "boolean",
        confidence: 0.75,
        sourceExcerpt: needsMatch.find((m) => m.includes(def.property)) ?? userText.slice(0, 100),
      });
    }
  }

  // Framework/library name extraction
  const frameworkMatch = userText.match(
    /\b(React|Vue|Angular|Svelte|Next\.js|Nuxt|Solid|Preact)\b/i
  );
  if (frameworkMatch) {
    const fwDefs = relevantDefs.filter((d) =>
      d.canonicalKey.includes("framework") || d.property === "framework"
    );
    for (const def of fwDefs) {
      candidates.push({
        definitionId: def.id,
        value: frameworkMatch[0],
        valueType: "string",
        confidence: 0.8,
        sourceExcerpt: userText.slice(Math.max(0, userText.indexOf(frameworkMatch[0]) - 20), userText.indexOf(frameworkMatch[0]) + 30),
      });
    }
  }

  return candidates;
}

import type { ConversationFact } from "@/shared/context-fact-types";
