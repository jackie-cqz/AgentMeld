import { z } from "zod";
import { gateRequest } from "@/server/api-gate";
import { decideHandoff, getHandoff, getHandoffPackage } from "@/server/collaboration/handoffs";

const schema = z.object({ decision: z.enum(["accept", "decline", "cancel"]) }).strict();
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const gate = await gateRequest(request);
  if (!gate.allowed) return gate.response;
  const { id } = await context.params;
  const handoff = getHandoff(id);
  return handoff ? Response.json({ handoff, package: getHandoffPackage(id) }) : Response.json({ error: "Handoff not found." }, { status: 404 });
}
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const gate = await gateRequest(request);
  if (!gate.allowed) return gate.response;
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: parsed.error.flatten() }, { status: 400 });
  const { id } = await context.params;
  try { return Response.json(await decideHandoff(id, parsed.data.decision, gate.principal), { status: 202 }); }
  catch (error) { return Response.json({ error: error instanceof Error ? error.message : "交接操作失败。" }, { status: 409 }); }
}
