import { z } from "zod";
import { sendMessage } from "@/server/conversation-service";
import { gateRequest } from "@/server/api-gate";
import { MessageSubmissionError } from "@/server/collaboration/message-submissions";

export const dynamic = "force-dynamic";

const sendMessageSchema = z.object({
  content: z.string().trim().min(1).max(8000),
  mentionedAgentIds: z.array(z.string().min(1)).max(8).optional(),
  attachmentIds: z.array(z.string().min(1)).max(10).optional(),
  parentMessageId: z.string().min(1).nullable().optional(),
  clientRequestId: z.string().trim().min(1).max(120).optional(),
  action: z.enum(["discussion", "new_task", "progress", "supplement", "correction", "cancel"]).optional(),
  targetRunId: z.string().min(1).optional(),
});

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const gate = await gateRequest(request);
  if (!gate.allowed) return gate.response;
  const { id } = await context.params;
  const body = await request.json().catch(() => ({}));
  const parsed = sendMessageSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  try {
    const result = await sendMessage({
      origin: "human",
      conversationId: id,
      content: parsed.data.content,
      mentionedAgentIds: parsed.data.mentionedAgentIds,
      attachmentIds: parsed.data.attachmentIds,
      parentMessageId: parsed.data.parentMessageId,
      clientRequestId: parsed.data.clientRequestId, action: parsed.data.action, targetRunId: parsed.data.targetRunId,
    });
    return Response.json(result, { status: 202 });
  } catch (error) {
    if (error instanceof MessageSubmissionError) return Response.json({ error: error.message, code: error.code }, { status: 409 });
    return Response.json({ error: error instanceof Error ? error.message : "Failed to send message." }, { status: 400 });
  }
}
