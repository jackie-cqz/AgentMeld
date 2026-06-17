import { z } from "zod";
import { approvePendingBash, getPendingBash, rejectPendingBash } from "@/server/pending-bash";
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

  const entry = getPendingBash(id);
  if (!entry) {
    return Response.json({ error: "Pending bash command not found." }, { status: 404 });
  }

  if (parsed.data.approved) {
    approvePendingBash(id);
    eventBus.publish({
      type: "bash_command.resolved",
      conversationId: entry.command.conversationId,
      timestamp: Date.now(),
      pendingId: id,
      approved: true
    });
    return Response.json({ resolved: true, approved: true });
  }

  rejectPendingBash(id);
  eventBus.publish({
    type: "bash_command.resolved",
    conversationId: entry.command.conversationId,
    timestamp: Date.now(),
    pendingId: id,
    approved: false
  });
  return Response.json({ resolved: true, approved: false });
}
