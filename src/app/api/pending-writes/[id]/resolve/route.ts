import { z } from "zod";
import { approvePendingWrite, getPendingWrite, rejectPendingWrite } from "@/server/pending-writes";
import { eventBus } from "@/server/event-bus";

export const dynamic = "force-dynamic";

const resolveSchema = z.object({
  approved: z.boolean()
});

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;

  const body = await request.json().catch(() => ({}));
  const parsed = resolveSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const entry = getPendingWrite(id);
  if (!entry) {
    return Response.json({ error: "Pending write not found." }, { status: 404 });
  }

  if (parsed.data.approved) {
    approvePendingWrite(id);
    eventBus.publish({
      type: "fs_write.resolved",
      conversationId: entry.write.conversationId,
      timestamp: Date.now(),
      pendingId: id,
      applied: true
    });
    return Response.json({ resolved: true, applied: true });
  }

  rejectPendingWrite(id);
  eventBus.publish({
    type: "fs_write.resolved",
    conversationId: entry.write.conversationId,
    timestamp: Date.now(),
    pendingId: id,
    applied: false
  });
  return Response.json({ resolved: true, applied: false });
}
