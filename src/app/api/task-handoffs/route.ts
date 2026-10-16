import { z } from "zod";
import { gateRequest } from "@/server/api-gate";
import { proposeHandoff } from "@/server/collaboration/handoffs";

const schema = z.object({ sourceAttemptId: z.string().min(1), targetAgentId: z.string().min(1) }).strict();
export async function POST(request: Request) {
  const gate = await gateRequest(request);
  if (!gate.allowed) return gate.response;
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: parsed.error.flatten() }, { status: 400 });
  try { return Response.json(await proposeHandoff(parsed.data.sourceAttemptId, parsed.data.targetAgentId, gate.principal), { status: 201 }); }
  catch (error) { return Response.json({ error: error instanceof Error ? error.message : "无法创建交接。" }, { status: 409 }); }
}
