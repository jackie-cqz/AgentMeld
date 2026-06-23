import { z } from "zod";
import { createConversation, getBootstrapPayload } from "@/server/conversation-service";

export const dynamic = "force-dynamic";

const createConversationSchema = z.object({
  title: z.string().trim().min(1).max(80).optional(),
  mode: z.enum(["single", "group"]).optional(),
  agentIds: z.array(z.string().min(1)).max(8).optional(),
  fsWriteApprovalMode: z.enum(["auto", "review"]).optional()
});

export async function GET() {
  return Response.json(getBootstrapPayload().conversations);
}

export async function POST(request: Request) {
  const body = await request.json().catch(() => ({}));
  const parsed = createConversationSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  try {
    const conversation = createConversation(parsed.data);
    return Response.json({ conversation }, { status: 201 });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Failed to create conversation." }, { status: 400 });
  }
}
