import { z } from "zod";
import { modelProviderSchema } from "@/shared/model-provider-schema";
import { deleteAgent, getAgentById, updateAgent } from "@/server/agent-service";
import { gateRequest } from "@/server/api-gate";

export const dynamic = "force-dynamic";

const patchAgentSchema = z.object({
  adapterName: z.literal("pi").optional(),
  name: z.string().trim().min(1).max(80).optional(),
  avatar: z.string().max(10).optional(),
  description: z.string().max(500).optional(),
  capabilities: z.array(z.string()).max(10).optional(),
  modelProvider: modelProviderSchema.nullable().optional(),
  modelId: z.string().max(100).nullable().optional(),
  apiKey: z.string().max(200).nullable().optional(),
  apiBaseUrl: z.string().max(500).nullable().optional(),
  contextWindow: z.number().int().min(1000).max(10_000_000).nullable().optional(),
  reasoningEffort: z.enum(["low", "medium", "high"]).nullable().optional(),
  systemPrompt: z.string().max(4000).optional(),
  toolNames: z.array(z.string()).max(64).optional()
});

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const gate = await gateRequest(request);
  if (!gate.allowed) return gate.response;
  const { id } = await context.params;
  const agent = getAgentById(id);
  if (!agent) {
    return Response.json({ error: "Agent not found." }, { status: 404 });
  }
  return Response.json({ agent });
}

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const gate = await gateRequest(request);
  if (!gate.allowed) return gate.response;
  const { id } = await context.params;
  const body = await request.json().catch(() => ({}));
  const parsed = patchAgentSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  try {
    const agent = updateAgent(id, parsed.data);
    if (!agent) {
      return Response.json({ error: "Agent not found." }, { status: 404 });
    }
    return Response.json({ agent });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Failed to update agent." },
      { status: 400 }
    );
  }
}

export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  const gate = await gateRequest(request);
  if (!gate.allowed) return gate.response;
  const { id } = await context.params;
  try {
    const deleted = deleteAgent(id);
    if (!deleted) {
      return Response.json({ error: "Agent not found." }, { status: 404 });
    }
    return new Response(null, { status: 204 });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Cannot delete this agent." },
      { status: 400 }
    );
  }
}
