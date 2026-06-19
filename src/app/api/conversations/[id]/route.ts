import { z } from "zod";
import { ensureDatabase } from "@/db/bootstrap";
import { deleteConversation, getConversationPayload } from "@/server/conversation-service";
import { updateConversation } from "@/server/repositories";

export const dynamic = "force-dynamic";

const patchSchema = z.object({
  archived: z.boolean().optional(),
  title: z.string().optional(),
  pinnedMessageIds: z.array(z.string()).optional()
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
  ensureDatabase();
  const { id } = await context.params;
  const body = await request.json().catch(() => ({}));
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const updated = updateConversation(id, parsed.data);
  if (!updated) {
    return Response.json({ error: "Conversation not found." }, { status: 404 });
  }
  return Response.json({ conversation: updated });
}

export async function DELETE(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const deleted = deleteConversation(id);
  if (!deleted) {
    return Response.json({ error: "Conversation not found." }, { status: 404 });
  }
  return Response.json({ deleted: true });
}
