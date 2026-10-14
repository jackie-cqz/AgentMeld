import { sendMessage } from "@/server/conversation-service";
import { eventBus, type EventBusEntry } from "@/server/event-bus";
import { resolveChannelConversation } from "@/server/channels/feishu/conversation-binding";
import {
  claimChannelInboundMessage,
  findAgentIdByBotOpenId,
  listChannelConversationMembers,
  setChannelInboundMessageId
} from "@/server/repositories";
import { newChannelInboundMessageId } from "@/shared/ids";
import type { ChannelInboundMessage, MessageOrigin } from "@/shared/types";

/**
 * Take one inbound channel message in: deduplicate it, put it in the
 * conversation its chat maps to, and let the existing dispatch decide who
 * answers.
 *
 * This module adds NO routing rules of its own. Who responds is decided by
 * `sendMessage` exactly as it is for the web UI — mention someone and they
 * answer, mention nobody and the conductor takes it. A Feishu message is the
 * same event arriving through a different door, and giving it its own rules
 * would mean two behaviours to keep in step.
 *
 * It also never sends anything back. It cannot: the only thing it produces is a
 * local message. That keeps §5.8's first rule true by construction rather than
 * by discipline.
 *
 * Known limitation, from review: the SDK batches deliveries per chat by default
 * and labels the batch with its LAST message id, so this claim is keyed on that
 * representative. A redelivery that happens to be batched differently would
 * therefore present a different id and be routed again. The SDK's own dedup
 * would catch that, but it is in-memory unless a persistent Cache is injected —
 * which this does not do. Narrow (it needs both a redelivery and a different
 * batch grouping) but real, and it is the reason §5.1's "inject the cache"
 * recommendation still stands as work to do rather than a decision already
 * taken.
 */
export type RouteOutcome =
  | { status: "duplicate" }
  | { status: "ignored"; reason: string }
  | {
      status: "routed";
      conversationId: string;
      messageId: string;
      runIds: string[];
      origin: MessageOrigin;
    };

/**
 * Who authored this, in AgentMeld's terms.
 *
 * An absent or unrecognised sender kind becomes `internal`, not `human`. That
 * is the safe direction: `internal` cannot start a run, so an event whose sender
 * we could not identify is recorded without being acted on, rather than being
 * handed the permissions of a person.
 */
export function originForSender(
  senderType: string | null,
  senderIsBot: boolean | null
): MessageOrigin {
  // `senderIsBot` is derived from `senderType` and is undefined when the
  // platform omitted it — so it can only ever confirm, never contradict.
  if (senderIsBot === true || senderType === "bot") return "bot";
  if (senderType === "user") return "human";
  return "internal";
}

/**
 * The agents an inbound message is addressed to.
 *
 * A message that mentions two bots is delivered once per bot, and the addressee
 * list is the same in every one of those deliveries — so any single delivery
 * carries the whole set. Without that, the second addressee's own delivery
 * would be discarded as a duplicate of the first, and it would never be asked
 * to answer.
 *
 * A mention proves membership: only a bot that is in a chat can be mentioned in
 * it, so each mentioned agent is recorded as present here. That is the same
 * evidence rule the rest of membership uses — we simply got it from the mention
 * rather than from that bot's own delivery.
 */
function addressees(inbound: ChannelInboundMessage, participants: string[]): string[] {
  const known = new Set(participants);
  const addressees = new Set<string>();

  // The receiving bot is an addressee by definition: it was mentioned, which is
  // the only way it would have this message at all.
  if (known.has(inbound.agentId)) addressees.add(inbound.agentId);

  for (const openId of inbound.mentionOpenIds) {
    const agentId = findAgentIdByBotOpenId(inbound.channel, openId);
    if (agentId && known.has(agentId)) addressees.add(agentId);
  }

  return [...addressees];
}

export async function routeChannelInbound(
  inbound: ChannelInboundMessage,
  now = Date.now()
): Promise<RouteOutcome> {
  const { channelConversation } = resolveChannelConversation({
    channel: inbound.channel,
    chatId: inbound.chatId,
    chatType: inbound.chatType,
    receivingAgentId: inbound.agentId,
    now
  });

  // Deduplicate before any dispatch. The claim is atomic, so a concurrent or
  // redelivered copy stops here. Note that resolving the conversation above it
  // has already run — those side effects are idempotent, and the claim has to
  // know which conversation it is recording against.
  const claimId = newChannelInboundMessageId();
  const claimed = claimChannelInboundMessage({
    id: claimId,
    channel: inbound.channel,
    chatId: inbound.chatId,
    externalMessageId: inbound.messageId,
    conversationId: channelConversation.conversationId,
    agentId: inbound.agentId,
    now
  });
  if (!claimed) return { status: "duplicate" };

  // Record every mentioned agent as present BEFORE deciding whether there is
  // anything to hand to an agent. An @ with no text is a real interaction — the
  // SDK explicitly wakes a bot on a bare mention — and it is still evidence that
  // the mentioned bot is in the room. Returning early here used to lose that.
  for (const openId of inbound.mentionOpenIds) {
    const agentId = findAgentIdByBotOpenId(inbound.channel, openId);
    if (agentId) {
      resolveChannelConversation({
        channel: inbound.channel,
        chatId: inbound.chatId,
        chatType: inbound.chatType,
        receivingAgentId: agentId,
        now
      });
    }
  }

  const content = inbound.content.trim();
  if (!content) {
    // Recorded as seen, so a redelivery is not mistaken for a new message, but
    // there is nothing to hand to an agent.
    return { status: "ignored", reason: "empty content" };
  }

  const participants = listChannelConversationMembers(channelConversation.id);
  const mentionedAgentIds = addressees(inbound, participants);
  const origin = originForSender(inbound.senderType, inbound.senderIsBot);

  const result = await sendMessage({
    conversationId: channelConversation.conversationId,
    content,
    mentionedAgentIds,
    origin
  });

  setChannelInboundMessageId(claimId, result.message.id);

  return {
    status: "routed",
    conversationId: channelConversation.conversationId,
    messageId: result.message.id,
    runIds: result.runIds,
    origin
  };
}

declare global {
  var __agentMeldChannelRouterStop: (() => void) | undefined;
}

/**
 * Start taking inbound messages off the event bus.
 *
 * Subscribes once per process: this module is re-evaluated on hot reload, and a
 * second subscription would route every message twice — which the per-message
 * claim would turn into a silent drop of the second copy rather than a visible
 * error.
 */
export function startChannelRouter(): () => void {
  if (globalThis.__agentMeldChannelRouterStop) return globalThis.__agentMeldChannelRouterStop;

  const stop = eventBus.subscribe((entry: EventBusEntry) => {
    if (entry.event.type !== "channel.inbound") return;
    void routeChannelInbound(entry.event.message).catch((error: unknown) => {
      // Nothing to retry into: the claim is already written, so the message is
      // recorded even though routing it failed. Better a logged gap than an
      // infinite retry against a message that will fail the same way.
      console.error("[feishu] failed to route an inbound message:", error);
    });
  });

  globalThis.__agentMeldChannelRouterStop = stop;
  return stop;
}

export function stopChannelRouterForTests(): void {
  globalThis.__agentMeldChannelRouterStop?.();
  globalThis.__agentMeldChannelRouterStop = undefined;
}
