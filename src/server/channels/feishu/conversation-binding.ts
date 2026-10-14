import {
  addChannelConversationMember,
  createChannelConversation,
  createConversation,
  getChannelConversationByChat,
  getConversation,
  listChannelConversationMembers,
  updateConversation
} from "@/server/repositories";
import { createWorkspace } from "@/server/conversation-service";
import { newChannelConversationId, newConversationId } from "@/shared/ids";
import type { ChannelConversation } from "@/shared/types";

/**
 * Find or create the AgentMeld conversation a channel chat maps to, and record
 * that this agent's bot is present there.
 *
 * Membership is learned, not declared. No granted scope can list a chat's bots
 * (`getChatBots` answers 400), so the only evidence that an agent belongs to a
 * group is that its bot received an event in it. A conversation therefore starts
 * with whoever spoke first and grows as other agents' bots are seen — which is
 * also why the receiving agent is added on every call, not just on creation.
 *
 * The title comes from the chat id because the account also cannot read a chat's
 * name. It is a placeholder a human can rename, not a guess at real content.
 */
export function resolveChannelConversation(input: {
  channel: "feishu";
  chatId: string;
  chatType: "p2p" | "group";
  receivingAgentId: string;
  now: number;
}): { channelConversation: ChannelConversation; created: boolean } {
  const existing = getChannelConversationByChat(input.channel, input.chatId);

  if (existing) {
    joinChannelConversation(existing, input.receivingAgentId, input.now);
    return { channelConversation: existing, created: false };
  }

  const conversation = createConversation({
    id: newConversationId(),
    title: `飞书${input.chatType === "p2p" ? "单聊" : "群"} · ${input.chatId.slice(-6)}`,
    mode: input.chatType === "p2p" ? "single" : "group",
    agentIds: [input.receivingAgentId],
    fsWriteApprovalMode: "auto",
    now: input.now
  });

  // The service's createConversation does this, but its rules do not fit here:
  // it requires at least two agents for a group, and a discovered group starts
  // with the one agent whose bot spoke first. Members accumulate from then on.
  // Skipping the workspace is not an option — every run would fail with
  // "Workspace not found".
  createWorkspace(conversation.id, input.now);

  let channelConversation: ChannelConversation;
  try {
    channelConversation = createChannelConversation({
      id: newChannelConversationId(),
      channel: input.channel,
      chatId: input.chatId,
      conversationId: conversation.id,
      now: input.now
    });
  } catch (error) {
    // Two deliveries for a chat can arrive together, and the unique index on
    // (channel, chat_id) is what makes that safe — but one of them loses. It
    // adopts the winner's mapping rather than failing: the conversation the
    // loser just created is left with no chat pointing at it, which is untidy
    // but harmless, whereas throwing would drop a real message.
    const winner = getChannelConversationByChat(input.channel, input.chatId);
    if (!winner) throw error;
    joinChannelConversation(winner, input.receivingAgentId, input.now);
    return { channelConversation: winner, created: false };
  }

  addChannelConversationMember({
    channelConversationId: channelConversation.id,
    agentId: input.receivingAgentId,
    now: input.now
  });

  return { channelConversation, created: true };
}

/**
 * Record that an agent's bot has been seen in a chat, in both places that care:
 * the evidence table (who has been observed) and the conversation's participant
 * list (who may speak). Without the second, a mentioned agent would be a member
 * of the chat but not of the conversation, and `pickResponders` would never
 * route to it.
 */
export function joinChannelConversation(
  channelConversation: ChannelConversation,
  agentId: string,
  now: number
): void {
  addChannelConversationMember({
    channelConversationId: channelConversation.id,
    agentId,
    now
  });

  const conversation = getConversation(channelConversation.conversationId);
  if (!conversation || conversation.agentIds.includes(agentId)) return;

  updateConversation(conversation.id, {
    agentIds: [...conversation.agentIds, agentId],
    now
  });
}

/** Agents whose bot has been observed in this chat, in first-seen order. */
export function listObservedAgents(channelConversationId: string): string[] {
  return listChannelConversationMembers(channelConversationId);
}
