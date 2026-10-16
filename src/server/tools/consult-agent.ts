import { z } from "zod";
import { TOOL_CAPABILITIES } from "./capabilities";
import type { ToolDef } from "./types";

const requestSchema = z.object({
  requestKey: z.string().trim().min(1).max(100),
  targetAgentId: z.string().min(1).max(100),
  question: z.string().trim().min(1).max(3000),
  artifactIds: z.array(z.string().min(1)).max(3).default([]),
}).strict();

export const consultAgentTool: ToolDef = {
  name: "consult_agent",
  capabilities: TOOL_CAPABILITIES.consult_agent,
  description: "Ask another current team member for one bounded read-only opinion. Does not delegate execution, approve actions, create facts or verify completion. Use the same requestKey when retrying the same question. The peer gets only the question, current constraints and selected immutable artifact snapshots, not live files. No nested consultations.",
  parameters: { type: "object", required: ["requestKey", "targetAgentId", "question"], additionalProperties: false, properties: {
    requestKey: { type: "string", description: "Stable unique key within this run for this question; reuse only for an identical retry." },
    targetAgentId: { type: "string", description: "Exact ID of another current team member." },
    question: { type: "string", maxLength: 3000 },
    artifactIds: { type: "array", items: { type: "string" }, maxItems: 3 },
  } },
  async handler(args, ctx) {
    const request = requestSchema.safeParse(args);
    if (!request.success) return { ok: false, error: request.error.message };
    const { requestConsultation } = await import("@/server/collaboration/consultations");
    return { ok: true, value: await requestConsultation(request.data, ctx) };
  },
};

const responseSchema = z.object({ status: z.enum(["replied", "declined"]), answer: z.string().trim().min(1).max(6000) }).strict();

/** Internal only: not offered as a configurable general-purpose tool grant. */
export const respondToConsultationTool: ToolDef = {
  name: "respond_to_consultation",
  capabilities: TOOL_CAPABILITIES.respond_to_consultation,
  description: "Submit a focused peer opinion, or decline with a reason, for this admitted consultation. This ends the consultation; it is not a task completion report or verified evidence.",
  parameters: { type: "object", required: ["status", "answer"], additionalProperties: false, properties: {
    status: { type: "string", enum: ["replied", "declined"] }, answer: { type: "string", maxLength: 6000 },
  } },
  async handler(args, ctx) {
    const response = responseSchema.safeParse(args);
    if (!response.success) return { ok: false, error: response.error.message };
    const { proposeConsultationResponse } = await import("@/server/collaboration/consultations");
    proposeConsultationResponse(ctx, response.data.status, response.data.answer);
    return { ok: true, value: { accepted: true, status: response.data.status } };
  },
};
