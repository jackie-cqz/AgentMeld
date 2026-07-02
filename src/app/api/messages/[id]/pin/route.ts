import { z } from "zod";
import {
  getConversation,
  getMessage,
  updateConversation
} from "@/server/repositories";

export const dynamic = "force-dynamic";

const pinSchema = z.object({
  pinned: z.boolean()
});

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const body = await request.json().catch(() => ({}));
  const parsed = pinSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const message = getMessage(id);
  if (!message) return Response.json({ error: "Message not found." }, { status: 404 });

  const conv = getConversation(message.conversationId);
  if (!conv) return Response.json({ error: "Conversation not found." }, { status: 404 });

  const currentPins = conv.pinnedMessageIds ?? [];
  let newPins: string[];

  if (parsed.data.pinned) {
    if (currentPins.includes(id)) {
      return Response.json({ pinnedMessageIds: currentPins });
    }
    newPins = [...currentPins, id];
  } else {
    newPins = currentPins.filter((pid) => pid !== id);
  }

  updateConversation(message.conversationId, { pinnedMessageIds: newPins, now: Date.now() });

  return Response.json({ messageId: id, pinned: parsed.data.pinned, pinnedMessageIds: newPins });
}
