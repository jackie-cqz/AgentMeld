import { getPendingWritesForConversation } from "@/server/pending-writes";
import { gateRequest } from "@/server/api-gate";

export const dynamic = "force-dynamic";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const gate = await gateRequest(request);
  if (!gate.allowed) return gate.response;
  const { id } = await context.params;
  const writes = getPendingWritesForConversation(id);
  return Response.json({ pendingWrites: writes });
}
