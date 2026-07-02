import { getDatabase } from "@/db/client";
import { abortRun } from "@/server/agent-runner";
import { sendMessage } from "@/server/conversation-service";
import { eventBus } from "@/server/event-bus";
import { getMessage } from "@/server/repositories";

export function withdrawMessage(messageId: string) {
  const db = getDatabase();
  const message = getMessage(messageId);
  if (!message) throw new Error("Message not found.");
  if (message.role !== "user") throw new Error("Only user messages can be withdrawn.");
  const latest = db
    .prepare("SELECT id FROM messages WHERE conversation_id = ? AND role = 'user' ORDER BY created_at DESC LIMIT 1")
    .get(message.conversationId) as { id: string } | undefined;
  if (latest?.id !== messageId) throw new Error("Only the latest user message can be withdrawn.");

  const runs = db
    .prepare("SELECT id FROM agent_runs WHERE trigger_message_id = ? AND status IN ('queued', 'running')")
    .all(messageId) as Array<{ id: string }>;
  for (const run of runs) abortRun(run.id);

  const relatedMessages = db
    .prepare(
      "SELECT id FROM messages WHERE conversation_id = ? AND created_at >= ? ORDER BY created_at ASC"
    )
    .all(message.conversationId, message.createdAt) as Array<{ id: string }>;
  const deletedMessageIds = Array.from(new Set([messageId, ...relatedMessages.map((item) => item.id)]));

  const relatedArtifacts = db
    .prepare("SELECT id FROM artifacts WHERE conversation_id = ? AND created_at >= ?")
    .all(message.conversationId, message.createdAt) as Array<{ id: string }>;
  const deletedArtifactIds = relatedArtifacts.map((item) => item.id);

  db.exec("BEGIN");
  try {
    for (const id of deletedMessageIds) {
      db.prepare("DELETE FROM messages WHERE id = ?").run(id);
    }
    for (const id of deletedArtifactIds) {
      db.prepare("DELETE FROM artifacts WHERE id = ?").run(id);
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }

  eventBus.publish({
    type: "message.removed",
    conversationId: message.conversationId,
    timestamp: Date.now(),
    messageIds: deletedMessageIds,
    artifactIds: deletedArtifactIds
  });

  return {
    conversationId: message.conversationId,
    deletedMessageIds,
    deletedArtifactIds,
    originalMessage: message
  };
}

export async function editMessage(messageId: string, content: string) {
  const existing = getMessage(messageId);
  if (!existing) throw new Error("Message not found.");
  if (existing.role !== "user") throw new Error("Only user messages can be edited.");

  const attachmentIds = existing.parts.flatMap((part) =>
    part.type === "image_attachment" || part.type === "file_attachment"
      ? [part.attachmentId]
      : []
  );
  const mutation = withdrawMessage(messageId);
  const result = await sendMessage({
    conversationId: existing.conversationId,
    content,
    mentionedAgentIds: existing.mentionedAgentIds,
    attachmentIds,
    parentMessageId: existing.parentMessageId
  });

  return { ...mutation, ...result };
}
