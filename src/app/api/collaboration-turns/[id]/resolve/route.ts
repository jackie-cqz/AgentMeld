import { z } from "zod";
import { gateRequest } from "@/server/api-gate";
import { resolveCollaborationTurn } from "@/server/collaboration/resolve-turn";
import { MessageSubmissionError } from "@/server/collaboration/message-submissions";

export const dynamic = "force-dynamic";
const schema = z.object({ action: z.enum(["discussion", "new_task", "progress", "supplement", "correction", "cancel"]), targetRunId: z.string().min(1).optional() }).strict();

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const gate = await gateRequest(request);
  if (!gate.allowed) return gate.response;
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: parsed.error.flatten() }, { status: 400 });
  const { id } = await context.params;
  try { return Response.json(await resolveCollaborationTurn(id, parsed.data.action, parsed.data.targetRunId, gate.principal), { status: 202 }); }
  catch (error) { return Response.json({ error: error instanceof Error ? error.message : "消息确认失败。" }, { status: error instanceof MessageSubmissionError ? 409 : 400 }); }
}
