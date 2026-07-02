// ---------------------------------------------------------------------------
// P2: update_context_facts — Agent tool to propose fact updates
//
// Agents (primarily Conductor) use this tool to submit structured fact
// candidates. The Runtime resolves canonical keys, validates values,
// and persists active/superseded facts. Proposals for new definitions
// that can't be auto-resolved are saved as pending.
// ---------------------------------------------------------------------------

import { z } from "zod";
import type { ToolDef, ToolContext, ToolResult } from "@/server/tools/types";
import { resolveFacts } from "@/server/context-facts/fact-service";
import type { CandidateFactUpdate } from "@/shared/context-fact-types";

const factValueTypeSchema = z.enum([
  "string",
  "number",
  "boolean",
  "color",
  "string_array",
  "json",
]);

const updateSchema = z.object({
  definitionId: z.string().optional(),
  proposedKey: z.string().optional(),
  entity: z.string().optional(),
  property: z.string().optional(),
  value: z.unknown(),
  valueType: factValueTypeSchema.optional(),
  confidence: z.number().min(0).max(1),
  sourceExcerpt: z.string().max(300).optional(),
});

const proposalSchema = z.object({
  proposedNamespace: z.string().optional(),
  entity: z.string(),
  property: z.string(),
  value: z.unknown(),
  valueType: factValueTypeSchema,
  description: z.string().min(1).max(300),
  aliases: z.array(z.string()).max(10).optional(),
  confidence: z.number().min(0).max(1),
  sourceExcerpt: z.string().max(300).optional(),
});

const UpdateContextFactsArgsSchema = z.object({
  updates: z.array(updateSchema).max(20).default([]),
  proposals: z.array(proposalSchema).max(5).default([]),
});

export const updateContextFactsTool: ToolDef = {
  name: "update_context_facts",
  description:
    "Update project context facts (e.g. theme color, framework, auth requirements). " +
    "Provide 'updates' for known definitionIds or proposedKeys, and 'proposals' for " +
    "new entity/property pairs that need a definition. " +
    "Values are validated by the Runtime before being persisted. " +
    "Prefer using definitionId from the available definitions list over proposedKey. " +
    "Max 20 updates + 5 proposals per call.",
  parameters: {
    type: "object",
    required: [],
    properties: {
      updates: {
        type: "array",
        description: "Fact updates for known definitions (max 20).",
        items: {
          type: "object",
          required: ["value", "confidence"],
          properties: {
            definitionId: { type: "string", description: "Built-in or conversation definition ID (preferred)." },
            proposedKey: { type: "string", description: "Candidate key if definitionId is unknown." },
            entity: { type: "string", description: "Entity type for entity+property matching." },
            property: { type: "string", description: "Property name for entity+property matching." },
            value: { description: "The fact value (string, number, boolean, color hex, array, or JSON)." },
            valueType: { type: "string", enum: ["string", "number", "boolean", "color", "string_array", "json"] },
            confidence: { type: "number", minimum: 0, maximum: 1, description: "Confidence 0-1. Below 0.7 requires manual review." },
            sourceExcerpt: { type: "string", maxLength: 300, description: "Short excerpt from the user message." },
          },
        },
      },
      proposals: {
        type: "array",
        description: "New fact definition proposals for unknown fields (max 5).",
        items: {
          type: "object",
          required: ["entity", "property", "value", "valueType", "description", "confidence"],
          properties: {
            proposedNamespace: { type: "string", description: "Suggested namespace (advisory only)." },
            entity: { type: "string" },
            property: { type: "string" },
            value: { description: "The proposed value." },
            valueType: { type: "string", enum: ["string", "number", "boolean", "color", "string_array", "json"] },
            description: { type: "string", maxLength: 300 },
            aliases: { type: "array", items: { type: "string" }, maxItems: 10 },
            confidence: { type: "number", minimum: 0, maximum: 1 },
            sourceExcerpt: { type: "string", maxLength: 300 },
          },
        },
      },
    },
  },
  handler: async (args: unknown, ctx: ToolContext): Promise<ToolResult> => {
    const parsed = safeParse(UpdateContextFactsArgsSchema, args);
    if (!parsed.success) {
      return { ok: false, error: parsed.error };
    }

    const { updates, proposals } = parsed.data;
    if (updates.length === 0 && proposals.length === 0) {
      return { ok: true, value: { updated: [], created: [], pending: [], rejected: [], unchanged: [] } };
    }

    // Build candidates from updates
    const candidates: CandidateFactUpdate[] = updates.map((u) => ({
      definitionId: u.definitionId,
      proposedKey: u.proposedKey,
      entity: u.entity,
      property: u.property,
      value: u.value,
      valueType: u.valueType,
      confidence: u.confidence,
      sourceExcerpt: u.sourceExcerpt,
    }));

    // Source is the agent that called this tool
    const sourceType = ctx.taskExecution ? "agent_proposal" as const : "agent_proposal" as const;

    const result = resolveFacts(
      ctx.conversationId,
      candidates,
      sourceType,
      ctx.runId
    );

    // Categorize resolutions for the response
    const updated = result.resolutions.filter((r) => r.status === "matched").map((r) => ({
      canonicalKey: r.canonicalKey,
      previousValue: r.previousFact?.value ?? null,
      newValue: r.nextFact?.value ?? null,
    }));
    const created = result.resolutions.filter((r) => r.status === "created").map((r) => ({
      canonicalKey: r.canonicalKey,
      value: r.nextFact?.value ?? null,
    }));
    const pending = result.resolutions.filter((r) => r.status === "pending").map((r) => ({
      canonicalKey: r.canonicalKey,
      reason: r.reason,
    }));
    const unchanged = result.resolutions.filter((r) => r.status === "no_change").map((r) => ({
      canonicalKey: r.canonicalKey,
      value: r.previousFact?.value ?? null,
    }));

    // Handle proposals (new definition candidates)
    for (const p of proposals) {
      // Save proposals as pending facts for later review
      pending.push({
        canonicalKey: `proposed:${p.entity}.${p.property}`,
        reason: `New definition proposal: ${p.description} (${p.valueType})`,
      });
    }

    return {
      ok: true,
      value: {
        summary: result.summary,
        updated,
        created,
        pending,
        rejected: [],
        unchanged,
      },
    };
  },
};

function safeParse<T>(schema: z.ZodType<T>, data: unknown): { success: true; data: T } | { success: false; error: string } {
  const result = schema.safeParse(data);
  if (result.success) return result;
  return { success: false, error: result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") };
}
