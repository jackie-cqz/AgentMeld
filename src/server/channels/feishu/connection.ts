import {
  createLarkChannel,
  type LarkChannel,
  type NormalizedMessage,
  type PolicyConfig,
  type RejectEvent
} from "@larksuite/channel";
import { ensureDatabase } from "@/db/bootstrap";
import { eventBus } from "@/server/event-bus";
import { listFeishuBindings } from "@/server/channels/feishu/binding";
import { getChannelBindingSecret } from "@/server/repositories";
import type {
  ChannelBinding,
  ChannelConnectionInfo,
  ChannelConnectionStatus,
  ChannelInboundMessage
} from "@/shared/types";

/**
 * One long connection per bound agent's app.
 *
 * Responsibilities stop at the transport: connect, report health, and publish
 * what arrives. Routing an inbound message to a conversation, and projecting
 * AgentMeld state back out, are separate concerns that live in their own
 * modules — keeping them out of here is what makes §5.8's first rule
 * enforceable, because this module never replies to anything.
 */

/**
 * Deliberately explicit rather than left to defaults, because two of these
 * change behaviour that matters:
 *
 * - `requireMention` — without it the bot answers every message in every group
 *   it can see, which is not what any of this is for.
 * - `botLoopGuard` — OFF by default. It is the transport-level backstop for
 *   §5.8, and `onTrip: "reject"` rather than `"drop"` so that a trip is
 *   *visible* in our own event stream instead of being swallowed. The vendor
 *   calls it a heuristic, so it is a backstop and never the only defence.
 */
const CHANNEL_POLICY: PolicyConfig = {
  requireMention: true,
  respondToMentionAll: false,
  botLoopGuard: {
    enabled: true,
    onTrip: "reject"
  }
};

interface ConnectionEntry {
  binding: ChannelBinding;
  channel: LarkChannel;
  status: ChannelConnectionStatus;
  botOpenId: string | null;
  botName: string | null;
  lastError: string | null;
  connectedAt: number | null;
}

declare global {
  var __agentMeldFeishuConnections: Map<string, ConnectionEntry> | undefined;
  var __agentMeldFeishuStarting: Promise<ChannelConnectionInfo[]> | undefined;
}

/**
 * Keyed by **appId**, not agentId: the platform splits an app's events across
 * two live connections, so a second connection for the same app silently
 * halves what each one receives (R6). Keying by app makes that structurally
 * impossible rather than a rule someone has to remember.
 */
function getRegistry(): Map<string, ConnectionEntry> {
  globalThis.__agentMeldFeishuConnections ??= new Map<string, ConnectionEntry>();
  return globalThis.__agentMeldFeishuConnections;
}

function publishConnection(
  binding: ChannelBinding,
  status: ChannelConnectionStatus,
  reason?: string
): void {
  eventBus.publish({
    type: "channel.connection",
    conversationId: "",
    timestamp: Date.now(),
    agentId: binding.agentId,
    appId: binding.appId,
    status,
    ...(reason ? { reason } : {})
  });
}

function toInbound(agentId: string, message: NormalizedMessage): ChannelInboundMessage {
  return {
    channel: "feishu",
    agentId,
    chatId: message.chatId,
    chatType: message.chatType,
    messageId: message.messageId,
    senderId: message.senderId,
    senderType: message.senderType ?? null,
    senderIsBot: message.senderIsBot ?? null,
    mentionedBot: message.mentionedBot,
    content: message.content,
    threadId: message.threadId ?? null,
    createTime: message.createTime
  };
}

function wireHandlers(entry: ConnectionEntry): void {
  const { binding, channel } = entry;

  channel.on("message", (message: NormalizedMessage) => {
    // Publish only. This module must never produce an outbound message in
    // response to an inbound one — that rule is the primary loop defence
    // (§5.8 layer 1), and it is easiest to keep when the code cannot do it.
    eventBus.publish({
      type: "channel.inbound",
      conversationId: "",
      timestamp: Date.now(),
      message: toInbound(binding.agentId, message)
    });
  });

  channel.on("reject", (event: RejectEvent) => {
    // `reason: "bot_loop"` shows up here, which is how we can tell the guard is
    // actually working rather than assuming it is.
    entry.lastError = `rejected: ${event.reason}`;
    publishConnection(binding, entry.status, `rejected:${event.reason}`);
  });

  channel.on("error", (error: unknown) => {
    entry.status = "error";
    entry.lastError = error instanceof Error ? error.message : String(error);
    publishConnection(binding, "error", entry.lastError);
  });

  channel.on("reconnecting", () => {
    entry.status = "reconnecting";
    publishConnection(binding, "reconnecting");
  });

  channel.on("reconnected", () => {
    entry.status = "reconnected";
    entry.lastError = null;
    publishConnection(binding, "reconnected");
  });
}

async function connectOne(binding: ChannelBinding, appSecret: string): Promise<ConnectionEntry> {
  const channel = createLarkChannel({
    appId: binding.appId,
    appSecret,
    policy: CHANNEL_POLICY,
    source: "agentmeld"
    // `loggerLevel` is deliberately left at the SDK default. It takes a numeric
    // enum that `@larksuite/channel` does not re-export, and importing the
    // underlying node-sdk directly would depend on hoisting rather than on a
    // declared dependency. The SDK's own connect banner is informative anyway;
    // the status the app cares about travels through our events.
  });

  const entry: ConnectionEntry = {
    binding,
    channel,
    status: "connected",
    botOpenId: null,
    botName: null,
    lastError: null,
    connectedAt: null
  };

  wireHandlers(entry);
  await channel.connect();
  entry.connectedAt = Date.now();

  try {
    const identity = channel.getBotIdentity();
    entry.botOpenId = identity.openId;
    entry.botName = identity.name;
  } catch (error) {
    // The connection is up; only the identity lookup failed. Not fatal, and
    // worth recording rather than failing the whole start.
    entry.lastError = `identity unavailable: ${error instanceof Error ? error.message : String(error)}`;
  }

  publishConnection(binding, "connected");
  return entry;
}

/**
 * Connect every bound agent's app. Idempotent: an app that already has a live
 * connection is left alone, and concurrent calls share one run.
 *
 * A single app failing (revoked secret, network) never prevents the others —
 * each is recorded with its own error and reported through its own event.
 */
export async function startFeishuChannels(): Promise<ChannelConnectionInfo[]> {
  // Two callers racing at startup would otherwise both see an empty registry
  // and both connect, which is exactly the event-splitting hazard above.
  if (globalThis.__agentMeldFeishuStarting) return globalThis.__agentMeldFeishuStarting;

  const run = (async () => {
    ensureDatabase();
    const registry = getRegistry();
    const bindings = listFeishuBindings();

    for (const binding of bindings) {
      if (registry.has(binding.appId)) continue;

      const secret = getChannelBindingSecret(binding.id);
      if (!secret) {
        // A binding without a secret cannot connect. Report it instead of
        // failing silently; the row should not exist in this state.
        eventBus.publish({
          type: "channel.connection",
          conversationId: "",
          timestamp: Date.now(),
          agentId: binding.agentId,
          appId: binding.appId,
          status: "error",
          reason: "missing app secret"
        });
        continue;
      }

      try {
        registry.set(binding.appId, await connectOne(binding, secret));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        eventBus.publish({
          type: "channel.connection",
          conversationId: "",
          timestamp: Date.now(),
          agentId: binding.agentId,
          appId: binding.appId,
          status: "error",
          reason: message
        });
      }
    }

    return listFeishuConnections();
  })();

  globalThis.__agentMeldFeishuStarting = run;
  try {
    return await run;
  } finally {
    globalThis.__agentMeldFeishuStarting = undefined;
  }
}

/** Close every connection. Safe to call when nothing is connected. */
export async function stopFeishuChannels(): Promise<void> {
  const registry = getRegistry();
  const entries = [...registry.values()];
  registry.clear();
  await Promise.all(
    entries.map(async (entry) => {
      try {
        await entry.channel.disconnect();
      } catch {
        // Shutting down: a failed disconnect is not actionable.
      }
      publishConnection(entry.binding, "disconnected");
    })
  );
}

/**
 * The live channel for an agent, for outbound projection. `null` when that
 * agent has no binding, or its connection failed — callers must treat that as
 * "this agent has no Feishu presence", never as "use someone else's".
 */
export function getFeishuChannelForAgent(agentId: string): LarkChannel | null {
  for (const entry of getRegistry().values()) {
    if (entry.binding.agentId === agentId) return entry.channel;
  }
  return null;
}

export function listFeishuConnections(): ChannelConnectionInfo[] {
  return [...getRegistry().values()].map((entry) => ({
    agentId: entry.binding.agentId,
    appId: entry.binding.appId,
    status: entry.status,
    botOpenId: entry.botOpenId,
    botName: entry.botName,
    lastError: entry.lastError,
    connectedAt: entry.connectedAt
  }));
}

export function resetFeishuConnectionsForTests(): void {
  globalThis.__agentMeldFeishuConnections = undefined;
  globalThis.__agentMeldFeishuStarting = undefined;
}
