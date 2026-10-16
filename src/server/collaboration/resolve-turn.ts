import { ensureDatabase } from "@/db/bootstrap";
import { getConversation, getMessage } from "@/server/repositories";
import { sendMessage } from "@/server/conversation-service";
import { describePrincipal, type AuthPrincipal } from "@/server/auth";
import type { CollaborationAction } from "@/shared/collaboration-types";
import { getCollaborationTurn, updateCollaborationTurn } from "./turns";

export async function resolveCollaborationTurn(id: string, action: CollaborationAction, targetRunId: string | undefined, principal: AuthPrincipal) {
  ensureDatabase();
  const actor = describePrincipal(principal);
  if (!actor) throw new Error("Authenticated human identity is required.");
  const turn = getCollaborationTurn(id);
  if (!turn || !["needs_confirmation", "resolved"].includes(turn.status)) throw new Error("This turn is not waiting for a decision.");
  const message = getMessage(turn.messageId);
  const conversation = getConversation(turn.conversationId);
  if (!message || message.origin !== "human" || message.conversationId !== turn.conversationId || !conversation?.agentIds.includes(turn.agentId)) throw new Error("The original message or recipient is no longer available.");
  const labels: Record<CollaborationAction, string> = { discussion: "继续讨论", new_task: "作为新任务执行", progress: "查询进度", supplement: "补充当前工作", correction: "纠正当前工作", cancel: "停止关联工作" };
  const original = message.parts.filter(part => part.type === "text").map(part => part.content).join("\n");
  const result = await sendMessage({ origin: "human", conversationId: conversation.id, mentionedAgentIds: [turn.agentId],
    content: `用户已确认处理方式：${labels[action]}。\n\n原始消息：\n${original}`,
    attachmentIds: message.parts.flatMap(part => part.type === "file_attachment" || part.type === "image_attachment" ? [part.attachmentId] : []),
    parentMessageId: message.id, clientRequestId: `resolve:${turn.id}`, action, targetRunId,
  });
  updateCollaborationTurn(turn.id, { status: "resolved", reason: `用户已确认：${labels[action]}。`, resolvedBy: actor, resolvedAt: Date.now(), resolutionMessageId: result.message.id });
  return result;
}
