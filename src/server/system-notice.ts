import { getDatabase } from "@/db/client";
import { eventBus } from "@/server/event-bus";
import { newMessageId } from "@/shared/ids";
import type { MessageOrigin } from "@/shared/types";

/**
 * Write a system message into a conversation and publish it on the live stream.
 *
 * Used by context compaction and by visible truncation notices. The origin is
 * stated once: the row and the published event must not drift, because a
 * client that reloads has to see the same origin the live event carried.
 */
export function postSystemMessage(conversationId: string, content: string, origin: MessageOrigin = "internal"): void {
  const now = Date.now();
  const messageId = newMessageId();
  const parts = [{ type: "text" as const, content }];

  getDatabase().prepare(`
    INSERT INTO messages (
      id, conversation_id, role, origin, agent_id, run_id, parts, status,
      mentioned_agent_ids, parent_message_id, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    messageId,
    conversationId,
    "system",
    origin,
    null,
    null,
    JSON.stringify(parts),
    "complete",
    JSON.stringify([]),
    null,
    now,
    now
  );

  eventBus.publish({
    type: "message.added",
    conversationId,
    timestamp: now,
    message: {
      id: messageId,
      conversationId,
      role: "system",
      origin,
      agentId: null,
      runId: null,
      parts,
      status: "complete",
      parentMessageId: null,
      mentionedAgentIds: [],
      createdAt: now,
      updatedAt: now
    }
  });
}

/**
 * Make a truncation visible: the user sees how many older messages were left
 * out, and that the rest was kept. Silence here used to be a real data-loss
 * bug — the prompt was trimmed with no trace anywhere.
 */
export function reportContextTruncation(conversationId: string, droppedMessageCount: number, contextWindow: number): void {
  if (droppedMessageCount <= 0) return;
  postSystemMessage(
    conversationId,
    `上下文超出模型窗口（约 ${contextWindow.toLocaleString("en-US")} tokens），本次运行已裁剪最旧的 ${droppedMessageCount} 条消息；置顶消息保留。压缩后历史会更短，可手动压缩或减少置顶内容。`
  );
}
