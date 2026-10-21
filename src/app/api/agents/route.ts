import { z } from "zod";
import { modelProviderSchema } from "@/shared/model-provider-schema";
import { selectableAdapterNameSchema } from "@/shared/harness-schema";
import { createAgent, getAllAgents } from "@/server/agent-service";
import { gateRequest } from "@/server/api-gate";

export const dynamic = "force-dynamic";

const createAgentSchema = z.object({
  name: z.string().trim().min(1).max(80),
  avatar: z.string().max(10).optional(),
  description: z.string().max(500).optional(),
  capabilities: z.array(z.string()).max(10).optional(),
  adapterName: selectableAdapterNameSchema,
  modelProvider: modelProviderSchema.nullable().optional(),
  modelId: z.string().max(100).nullable().optional(),
  apiKey: z.string().max(200).nullable().optional(),
  apiBaseUrl: z.string().max(500).nullable().optional(),
  contextWindow: z.number().int().min(1000).max(10_000_000).nullable().optional(),
  reasoningEffort: z.enum(["low", "medium", "high"]).nullable().optional(),
  systemPrompt: z.string().max(4000).optional(),
  toolNames: z.array(z.string()).max(64).optional()
});

export async function GET(request: Request) {
  const gate = await gateRequest(request);
  if (!gate.allowed) return gate.response;
  const agents = getAllAgents();
  return Response.json({ agents });
}

export async function POST(request: Request) {
  const gate = await gateRequest(request);
  if (!gate.allowed) return gate.response;
  const body = await request.json().catch(() => ({}));
  const parsed = createAgentSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  try {
    const agent = createAgent(parsed.data);
    return Response.json({ agent }, { status: 201 });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Failed to create agent." },
      { status: 400 }
    );
  }
}
