import { z } from "zod";
import {
  deleteConversation,
  getConversationPayload,
  patchConversation
} from "@/server/conversation-service";

export const dynamic = "force-dynamic";

const patchConversationSchema = z.object({
  title: z.string().trim().min(1).max(80).optional(),
  archived: z.boolean().optional(),
  pinnedMessageIds: z.array(z.string().min(1)).max(5).optional(),
  fsWriteApprovalMode: z.enum(["auto", "review"]).optional()
});

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const payload = getConversationPayload(id);
  if (!payload) {
    return Response.json({ error: "Conversation not found." }, { status: 404 });
  }
  return Response.json(payload);
}

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const body = await request.json().catch(() => ({}));
  const parsed = patchConversationSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  try {
    const conversation = patchConversation(id, parsed.data);
    if (!conversation) {
      return Response.json({ error: "Conversation not found." }, { status: 404 });
    }
    return Response.json({ conversation });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Failed to update conversation." }, { status: 400 });
  }
}

export async function DELETE(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const deleted = deleteConversation(id);
  if (!deleted) {
    return Response.json({ error: "Conversation not found." }, { status: 404 });
  }
  return new Response(null, { status: 204 });
}
