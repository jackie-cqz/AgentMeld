import { getDatabase } from "@/db/client";
import { abortRun, isRunActive } from "@/server/agent-runner";
import { eventBus } from "@/server/event-bus";

export const dynamic = "force-dynamic";

export async function POST(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const db = getDatabase();

  // Get the message
  const msg = db.prepare("SELECT * FROM messages WHERE id = ?").get(id) as Record<string, unknown> | undefined;
  if (!msg) return Response.json({ error: "Message not found." }, { status: 404 });

  const conversationId = msg.conversation_id as string;

  // Abort any running runs triggered by this message
  const runs = db
    .prepare("SELECT id FROM agent_runs WHERE trigger_message_id = ? AND status = 'running'")
    .all(id) as Array<{ id: string }>;
  for (const run of runs) {
    abortRun(run.id);
  }

  // Collect related message/artifact IDs for cascade delete
  const relatedMessages = db
    .prepare("SELECT id FROM messages WHERE parent_message_id = ? OR (conversation_id = ? AND created_at >= ?)")
    .all(id, conversationId, msg.created_at) as Array<{ id: string }>;
  const deletedMessageIds = relatedMessages.map((m) => m.id);

  const relatedArtifacts = db
    .prepare("SELECT id FROM artifacts WHERE conversation_id = ? AND created_at >= ?")
    .all(conversationId, msg.created_at) as Array<{ id: string }>;
  const deletedArtifactIds = relatedArtifacts.map((a) => a.id);

  // Delete
  for (const mid of deletedMessageIds) {
    db.prepare("DELETE FROM messages WHERE id = ?").run(mid);
  }
  for (const aid of deletedArtifactIds) {
    db.prepare("DELETE FROM artifacts WHERE id = ?").run(aid);
  }

  eventBus.publish({
    type: "message.removed",
    conversationId,
    timestamp: Date.now(),
    messageIds: [id, ...deletedMessageIds],
    artifactIds: deletedArtifactIds
  });

  return Response.json({ deletedMessageIds, deletedArtifactIds });
}
