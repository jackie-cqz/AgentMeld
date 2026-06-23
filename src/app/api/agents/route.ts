import { z } from "zod";
import { createAgent, getAllAgents, DEFAULT_CUSTOM_PROMPT } from "@/server/agent-service";

export const dynamic = "force-dynamic";

const createAgentSchema = z.object({
  name: z.string().trim().min(1).max(80),
  avatar: z.string().max(10).optional(),
  description: z.string().max(500).optional(),
  capabilities: z.array(z.string()).max(10).optional(),
  adapterName: z.enum(["custom", "claude-code", "codex", "mock"]),
  modelProvider: z.enum(["openai", "deepseek", "volcano-ark", "anthropic", "openai-compatible"]).nullable().optional(),
  modelId: z.string().max(100).nullable().optional(),
  apiKey: z.string().max(200).nullable().optional(),
  apiBaseUrl: z.string().max(500).nullable().optional(),
  systemPrompt: z.string().max(4000).optional(),
  toolNames: z.array(z.string()).max(20).optional()
});

export async function GET() {
  const agents = getAllAgents();
  return Response.json({ agents });
}

export async function POST(request: Request) {
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
