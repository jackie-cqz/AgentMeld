import { z } from "zod";
import { sendMessage } from "@/server/conversation-service";

export const dynamic = "force-dynamic";

const sendMessageSchema = z.object({
  content: z.string().trim().min(1).max(8000),
  mentionedAgentIds: z.array(z.string().min(1)).max(8).optional(),
  attachmentIds: z.array(z.string().min(1)).max(10).optional()
});

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const body = await request.json().catch(() => ({}));
  const parsed = sendMessageSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  try {
    const result = await sendMessage({
      conversationId: id,
      content: parsed.data.content,
      mentionedAgentIds: parsed.data.mentionedAgentIds,
      attachmentIds: parsed.data.attachmentIds
    });
    return Response.json(result, { status: 202 });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Failed to send message." }, { status: 400 });
  }
}
