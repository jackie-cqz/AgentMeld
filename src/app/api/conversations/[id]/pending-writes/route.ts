import { getPendingWritesForConversation } from "@/server/pending-writes";

export const dynamic = "force-dynamic";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const writes = getPendingWritesForConversation(id);
  return Response.json({ pendingWrites: writes });
}
