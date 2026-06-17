import { getDatabase } from "@/db/client";
import { getConversation, listMessages } from "@/server/repositories";
import { newContextSummaryId, newMessageId } from "@/shared/ids";

export const dynamic = "force-dynamic";

export async function POST(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;

  const conversation = getConversation(id);
  if (!conversation) {
    return Response.json({ error: "Conversation not found." }, { status: 404 });
  }

  const allMessages = listMessages(id).filter((m) => m.status === "complete");
  if (allMessages.length < 10) {
    return Response.json({ compacted: false, reason: "Not enough messages to compact (need 10+)." });
  }

  // Skip pinned messages, keep last 6 recent
  const pinnedIds = new Set(conversation.pinnedMessageIds ?? []);
  const compactable = allMessages.filter((m) => !pinnedIds.has(m.id));
  const keepRecent = Math.min(6, Math.max(0, compactable.length - 10));
  const source = compactable.slice(0, compactable.length - keepRecent);

  if (source.length === 0) {
    return Response.json({ compacted: false, reason: "No compactable messages." });
  }

  // Build simple summary from message texts
  const texts = source
    .map((m) =>
      m.parts
        .filter((p) => p.type === "text")
        .map((p) => p.content)
        .join(" ")
    )
    .filter(Boolean);

  const summary = `[Compacted ${source.length} messages] ` + texts.slice(0, 20).join(" | ").slice(0, 2000);

  const now = Date.now();
  const lastSource = source[source.length - 1];

  // Store summary
  const db = getDatabase();
  db.prepare(`
    INSERT INTO conversation_context_summaries (
      id, conversation_id, summary, covered_until_message_id,
      covered_until_created_at, source_message_count, token_estimate,
      model_provider, model_id, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    newContextSummaryId(), id, summary,
    lastSource.id, lastSource.createdAt,
    source.length, Math.ceil(summary.length / 4),
    null, null, now
  );

  // Post a system message about the compaction
  db.prepare(`
    INSERT INTO messages (id, conversation_id, role, agent_id, run_id, parts, status, mentioned_agent_ids, parent_message_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    newMessageId(), id, "system", null, null,
    JSON.stringify([{ type: "text", content: `已压缩早期上下文，覆盖 ${source.length} 条消息。` }]),
    "complete", JSON.stringify([]), null, now, now
  );

  return Response.json({
    compacted: true,
    sourceMessageCount: source.length,
    coveredUntilMessageId: lastSource.id,
    summary
  });
}
