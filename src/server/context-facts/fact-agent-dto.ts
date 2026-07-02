// ---------------------------------------------------------------------------
// P2: Agent Fact DTO — filtered, role-aware definition list for Agent context
// ---------------------------------------------------------------------------

import {
  BUILTIN_FACT_DEFINITIONS,
  type FactDefinition,
} from "@/shared/builtin-fact-definitions";
import { loadActiveFacts, loadDynamicDefinitions } from "@/server/context-facts/fact-service";

export interface AgentDefinitionDTO {
  definitionId: string;
  canonicalKey: string;
  description: string;
  valueType: string;
  currentValue: unknown | null;
}

/**
 * Build a filtered list of fact definitions relevant to the current agent,
 * including current values for active facts. This is injected into the
 * Conductor's system prompt or task context.
 */
export function getFilteredDefinitionsForAgent(params: {
  conversationId: string;
  agentRole?: string;
  taskTags?: string[];
  userMessageText?: string;
}): AgentDefinitionDTO[] {
  const { conversationId, agentRole, userMessageText } = params;

  // Load active facts and dynamic definitions
  const activeFacts = loadActiveFacts(conversationId);
  const dynamicDefs = loadDynamicDefinitions(conversationId);

  // Merge builtin + dynamic
  const allDefs: FactDefinition[] = [...BUILTIN_FACT_DEFINITIONS, ...dynamicDefs];

  // Filter by agent role
  let filtered = allDefs;
  if (agentRole) {
    filtered = filtered.filter(
      (d) =>
        d.applicableAgentRoles.includes(agentRole) ||
        d.applicableAgentRoles.includes("conductor")
    );
  }

  // Filter by message relevance
  if (userMessageText) {
    const lower = userMessageText.toLowerCase();
    filtered = filtered.filter(
      (d) =>
        d.aliases.some((a) => lower.includes(a.toLowerCase())) ||
        lower.includes(d.entityType.toLowerCase()) ||
        lower.includes(d.property.toLowerCase())
    );
  }

  // Build DTO with current values
  return filtered.map((def) => {
    const activeFact = activeFacts.find(
      (f) => f.canonicalKey === def.canonicalKey && f.status === "active"
    );
    return {
      definitionId: def.id,
      canonicalKey: def.canonicalKey,
      description: def.description,
      valueType: def.valueType,
      currentValue: activeFact?.value ?? null,
    };
  });
}
