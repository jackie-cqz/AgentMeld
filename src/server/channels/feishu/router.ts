import { sendMessage } from "@/server/conversation-service";
import { createMessage } from "@/server/repositories";
import { eventBus, type EventBusEntry } from "@/server/event-bus";
import { resolveChannelConversation } from "@/server/channels/feishu/conversation-binding";
import { claimBindingOwner, hasLiveClaim } from "@/server/channels/feishu/binding";
import {
  claimChannelInboundMessage,
  findAgentIdByBotOpenId,
  listChannelConversationMembers,
  setChannelInboundMessageId
} from "@/server/repositories";
import {
  describeSkippedResources,
  importInboundResources
} from "@/server/channels/feishu/attachment-import";
import { newChannelInboundMessageId, newMessageId } from "@/shared/ids";
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
 * representative. A redelivery batched differently presents a different id and
 * reaches this table as a new message.
 *
 * What stops that is not this table but the persistent Cache injected into the
 * channel in `connection.ts` — the SDK marks every message id in a batch as
 * seen, and ours survives a restart. A test that feeds the same id twice proves
 * only that the table works for the case the table handles; the case that
 * matters is the differently-batched redelivery, and that one is the cache's.
 *
 * An earlier version of this comment said the cache was not injected. It is,
 * and has been since the cache work landed; the comment outlived the fact and
 * denied the mechanism its own paragraph depends on.
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
    threadId: inbound.threadId,
    now
  });
  if (!claimed) return { status: "duplicate" };

  // Manual (credentials) binding: the person who typed the app secret still has
  // to prove they are reachable as a Feishu user, because the credentials carry
  // no human identity and cards are authorised against one. The web page shows
  // a one-time code; sending it to the bot in the group claims the binding.
  //
  // Only while a claim is live, so ordinary use is untouched; and it never
  // reaches an agent, because the text is a code, not a request.
  const looksLikeClaimCode = /^\d{6}$/.test(inbound.content.trim());
  if (looksLikeClaimCode && originForSender(inbound.senderType, inbound.senderIsBot) === "human" && hasLiveClaim(inbound.agentId, now)) {
    const outcome = claimBindingOwner({
      agentId: inbound.agentId,
      // The SDK fills senderId with open_id ?? user_id ?? union_id; only an open
      // id can match a future callback, so a fallback would claim successfully
      // and then authorise nobody.
      openId: inbound.senderId,
      code: inbound.content,
      now
    });
    const notice = outcome.ok
      ? "绑定已认领：这个机器人的提问、审批与取消现在由你来作答。"
      : claimRefusal(outcome.reason);
    const noticeId = recordChannelNotice(
      channelConversation.conversationId,
      inbound.agentId,
      notice,
      now
    );
    return {
      status: "routed",
      conversationId: channelConversation.conversationId,
      messageId: noticeId ?? "",
      runIds: [],
      origin: "human"
    };
  }

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

  // Attachments are fetched before the message is written, so the message can
  // refer to them. A file that fails to arrive is reported in the room rather
  // than only in the server log — the person who sent it is the one who needs
  // to know.
  const imported = await importInboundResources({
    agentId: inbound.agentId,
    conversationId: channelConversation.conversationId,
    platformMessageId: inbound.messageId,
    resources: inbound.resources ?? []
  });
  const attachmentIds = imported.status === "imported" ? imported.attachmentIds : [];
  const skippedNote =
    imported.status === "imported"
      ? describeSkippedResources(imported.skipped)
      : // A skip is only worth saying when there is someone who could say it. If
        // the agent has no live channel there is no bot to deliver a complaint,
        // and "no attachments" is not news.
        imported.reason === "the conversation has no workspace"
        ? "⚠️ 有附件没能导入：这个会话还没有工作区，Agent 没有地方存放文件。"
        : null;

  const result = await sendMessage({
    conversationId: channelConversation.conversationId,
    content,
    mentionedAgentIds,
    attachmentIds,
    origin
  });

  if (skippedNote) {
    // Written as a SYSTEM message that names the agent, not as an ordinary
    // message. `sendMessage` produces role "user", and the channel projects
    // agent answers and system notices — so the notice this used to write was
    // recorded on the web and never left AgentMeld. The person who sent the
    // file is in the room, and that is where they need to be told.
    recordChannelNotice(channelConversation.conversationId, inbound.agentId, skippedNote, now);
  }

  setChannelInboundMessageId(claimId, result.message.id);

  return {
    status: "routed",
    conversationId: channelConversation.conversationId,
    messageId: result.message.id,
    runIds: result.runIds,
    origin
  };
}

/**
 * Record a notice that names an agent, so the room can hear it.
 *
 * System role plus an agent id is exactly the shape the channel projection
 * takes: a room's bot is per-agent, so a notice with no agent has no bot to
 * deliver it.
 */
function recordChannelNotice(conversationId: string, agentId: string, text: string, now: number): string | null {
  // A notice is a courtesy about a message that is already recorded. Throwing
  // here would reject the whole routing call and skip the bookkeeping that
  // follows it, so a failure to say something must not cost the record.
  try {
    const message = createMessage({
      id: newMessageId(),
      conversationId,
      agentId,
      role: "system",
      parts: [{ type: "text", content: text }],
      status: "complete",
      now
    });
    eventBus.publish({ type: "message.added", conversationId, timestamp: now, message });
    return message.id;
  } catch (error) {
    console.error("[feishu] failed to record a channel notice:", error);
    return null;
  }
}

/** What to say when a claim attempt does not succeed. */
function claimRefusal(reason: string): string {
  switch (reason) {
    case "expired":
      return "认领口令已过期，请在网页上重新生成。";
    case "too-many":
      return "口令输错次数过多，已作废。请在网页上重新生成。";
    case "wrong-code":
      return "口令不对。请核对网页上显示的口令，再发一次。";
    case "not-bound":
      return "这个机器人还没有绑定，请先在网页上完成绑定。";
    default:
      return "当前没有待认领的绑定。";
  }
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
