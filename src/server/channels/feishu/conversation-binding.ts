import type { ChatMember } from "@larksuite/channel";
import {
  addChannelConversationMember,
  findAgentIdByBotOpenId,
  removeChannelConversationMember,
  createChannelConversation,
  createConversation,
  deleteConversation,
  getChannelConversationByChat,
  getConversation,
  listChannelBindings,
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
 * (`getChatBots` answers 400 unless the app is granted `im:chat:readonly` (see docs/feishu-operations.md)), so the only evidence that an agent belongs to a
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
    // There is no creation dialog on this path, so state the default: a Feishu
    // conversation injects the original messages, with no verified-facts block.
    contextMode: "raw",
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
    // (channel, chat_id) is what makes that safe — but one of them loses.
    const winner = getChannelConversationByChat(input.channel, input.chatId);
    if (!winner) throw error;

    // Clean up the conversation this attempt created before adopting the
    // winner's. Leaving it would put an unreachable, workspace-less conversation
    // in the user's sidebar that no chat can ever speak to.
    deleteConversation(conversation.id);

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

/**
 * Drop the observed agents that are no longer in the chat.
 *
 * Feishu sends no "bot removed" event to a bot that is still in the group, so a
 * departure is only visible by asking who IS there. Two deliberate limits:
 *
 * - Agents this process cannot identify among the chat's bots are LEFT ALONE.
 *   "Not in the list I just fetched" is only evidence when we can match the
 *   agent to a bot at all; an empty or unhelpful answer must not empty the
 *   roster.
 * - Only the evidence table changes. The conversation's `agentIds` is a choice
 *   made by a person (and can be edited on the web), so a bot leaving the group
 *   does not silently remove the agent from the conversation.
 */
export function pruneObservedAgents(
  channelConversationId: string,
  presentAgentIds: readonly string[]
): string[] {
  const present = new Set(presentAgentIds);
  // "Not in the list I just fetched" is only evidence about an agent we can
  // match to a bot at all. Without this, a member whose binding has no
  // `bot_open_id` (an identity lookup that failed once, or a binding that was
  // removed) never appears in `present` and was deleted even when its bot was
  // in the list — the opposite of the rule this function documents, and a
  // deletion with no evidence behind it.
  const identifiable = new Set(
    listChannelBindings()
      .filter((binding) => binding.channel === "feishu" && binding.botOpenId)
      .map((binding) => binding.agentId)
  );

  const removed: string[] = [];
  for (const agentId of listChannelConversationMembers(channelConversationId)) {
    if (present.has(agentId)) continue;
    if (!identifiable.has(agentId)) continue;
    if (removeChannelConversationMember(channelConversationId, agentId)) removed.push(agentId);
  }
  return removed;
}

/**
 * Map as many of a chat's bots as we can onto agent ids.
 *
 * The shape is the SDK's `ChatMember`: `fetchChatBots` builds
 * `{ id: it.bot_id, idType: "open_id", name: it.bot_name, isBot: true }`, so the
 * open id is `id`. An earlier version also accepted `bot_id`/`openId` — fields
 * the SDK never returns — which meant the one shape that DOES occur in
 * production had no test at all, and deleting it stayed green.
 */
export function identifyChatBots(bots: readonly ChatMember[]): string[] {
  const agentIds: string[] = [];
  for (const bot of bots) {
    const openId = bot?.id;
    if (!openId) continue;
    const agentId = findAgentIdByBotOpenId("feishu", openId);
    if (agentId) agentIds.push(agentId);
  }
  return agentIds;
}

/**
 * Reconcile the roster with the chat, when the channel can tell us who is in it.
 *
 * Capability-checked and failure-tolerant: a channel without `getChatBots`, or
 * an API failure, leaves the roster exactly as it was.
 */
export async function syncChatMembership(
  channel: {
    getChatBots?: (chatId: string, opts?: { force?: boolean }) => Promise<ChatMember[]>;
  },
  channelConversationId: string,
  chatId: string
): Promise<string[]> {
  if (typeof channel.getChatBots !== "function") return [];
  let bots: unknown;
  try {
    // `force` because the SDK caches members per chat for five minutes: the
    // point of this call is what is true NOW, and a cached answer would report
    // a bot that just left as still present — silently doing nothing in exactly
    // the case this exists for.
    bots = await channel.getChatBots(chatId, { force: true });
  } catch (error) {
    console.error("[feishu] could not list the chat's bots:", error);
    return [];
  }
  if (!Array.isArray(bots) || bots.length === 0) return [];
  const present = identifyChatBots(bots);
  // Nothing in that list mapped onto one of our agents, so it says nothing
  // about any of them. Pruning here would empty the roster on the strength of
  // an id format we do not recognise.
  if (present.length === 0) return [];
  return pruneObservedAgents(channelConversationId, present);
}

/**
 * The reconciliation, plus the one thing the caller just learned.
 *
 * `keep` exists because the list is not always complete: a bot added a moment
 * ago may not be in it yet, and its binding may have no `bot_open_id` to match
 * on at all. Without this, `joinChannelConversation` followed by the
 * reconciliation could delete the agent it had just recorded.
 */
export async function syncChatMembershipKeeping(
  channel: {
    getChatBots?: (chatId: string, opts?: { force?: boolean }) => Promise<ChatMember[]>;
  },
  channelConversationId: string,
  chatId: string,
  keep: readonly string[]
): Promise<string[]> {
  const removed = await syncChatMembership(channel, channelConversationId, chatId);
  if (removed.length === 0) return removed;
  const keepSet = new Set(keep);
  const restored = removed.filter((agentId) => keepSet.has(agentId));
  for (const agentId of restored) {
    addChannelConversationMember({ channelConversationId, agentId, now: Date.now() });
  }
  return removed.filter((agentId) => !keepSet.has(agentId));
}
