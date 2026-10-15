import { z } from "zod";
import { ensureDatabase } from "@/db/bootstrap";
import { deleteConversation, getConversationPayload, patchConversation } from "@/server/conversation-service";
import { gateRequest } from "@/server/api-gate";

export const dynamic = "force-dynamic";

const patchSchema = z.object({
  archived: z.boolean().optional(),
  title: z.string().optional(),
  mode: z.enum(["single", "group"]).optional(),
  agentIds: z.array(z.string().min(1)).max(12).optional(),
  fsWriteApprovalMode: z.enum(["auto", "review"]).optional(),
  pinnedAt: z.number().nullable().optional(),
  pinnedMessageIds: z.array(z.string()).optional()
});

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const gate = await gateRequest(request);
  if (!gate.allowed) return gate.response;
  const { id } = await context.params;
  const payload = getConversationPayload(id);
  if (!payload) {
    return Response.json({ error: "Conversation not found." }, { status: 404 });
  }
  return Response.json(payload);
}

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const gate = await gateRequest(request);
  if (!gate.allowed) return gate.response;
  ensureDatabase();
  const { id } = await context.params;
  const body = await request.json().catch(() => ({}));
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  let updated;
  try {
    updated = patchConversation(id, parsed.data);
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Conversation update failed." },
      { status: 400 }
    );
  }
  if (!updated) {
    return Response.json({ error: "Conversation not found." }, { status: 404 });
  }
  return Response.json({ conversation: updated });
}

export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  const gate = await gateRequest(request);
  if (!gate.allowed) return gate.response;
  const { id } = await context.params;
  const deleted = deleteConversation(id);
  if (!deleted) {
    return Response.json({ error: "Conversation not found." }, { status: 404 });
  }
  return Response.json({ deleted: true });
}
