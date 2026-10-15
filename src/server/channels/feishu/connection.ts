import {
  createLarkChannel,
  type BotAddedEvent,
  type LarkChannel,
  type NormalizedMessage,
  type PolicyConfig,
  type RejectEvent
} from "@larksuite/channel";
import { ensureDatabase } from "@/db/bootstrap";
import {
  joinChannelConversation,
  syncChatMembership
} from "@/server/channels/feishu/conversation-binding";
import { getChannelConversationByChat } from "@/server/repositories";
import { createPersistentCache, type SdkCache } from "@/server/channels/feishu/cache";
import { handleCardAction } from "@/server/channels/feishu/interaction";
import {
  getRegistry,
  getStopEpoch,
  listFeishuConnections,
  type ConnectionEntry
} from "@/server/channels/feishu/registry";

// Re-exported so the places that only ever wanted to ask "which channel?" keep
// one import, and so the smoke of this module's lifecycle stays out of them.
export { getFeishuChannelForAgent, listFeishuConnections, resetFeishuConnectionsForTests } from "@/server/channels/feishu/registry";
import { eventBus } from "@/server/event-bus";
import { listFeishuBindings } from "@/server/channels/feishu/binding";
import { getChannelBindingSecret, setChannelBindingBotOpenId } from "@/server/repositories";
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

/** How long a failed app is left alone before another attempt. */
const RETRY_COOLDOWN_MS = 30_000;

/**
 * A per-app ceiling on connecting. The SDK applies its own timeout to the
 * WebSocket handshake but NOT to the HTTP calls `connect()` makes first, so an
 * app whose host never answers would otherwise hold the whole start open
 * forever — and with it every later app, because `__agentMeldFeishuStarting`
 * would never clear.
 */
const CONNECT_TIMEOUT_MS = 20_000;



/**
 * Keyed by **appId**, not agentId: the platform splits an app's events across
 * two live connections, so a second connection for the same app silently
 * halves what each one receives (R6). Keying by app makes that structurally
 * impossible rather than a rule someone has to remember.
 */
/**
 * One cache for the whole process, so every channel shares the dedup marks.
 *
 * Built lazily because it touches the database, which is not open at module
 * load.
 */
let persistentCache: SdkCache | undefined;
function getPersistentCache(): SdkCache {
  persistentCache ??= createPersistentCache();
  return persistentCache;
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
    // Only open ids: a mention's display name is set by whoever sent it and is
    // not identity.
    mentionOpenIds: message.mentions
      .map((mention) => mention.openId)
      .filter((openId): openId is string => Boolean(openId)),
    resources: (message.resources ?? []).map((resource) => ({
      type: resource.type,
      fileKey: resource.fileKey,
      fileName: resource.fileName ?? null
    })),
    content: message.content,
    threadId: message.threadId ?? null,
    createTime: message.createTime
  };
}

function wireHandlers(entry: ConnectionEntry, channel: LarkChannel): void {
  const { binding } = entry;

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

  channel.on("cardAction", (event) => {
    // Returned to the platform so the click gets immediate feedback and the card
    // updates in place. Nothing here awaits an agent run, which is what §5.4
    // requires: the SDK runs card actions and messages on the same per-chat
    // queue, so a handler that gave the work back to that queue would wait for
    // itself.
    // The app that delivered this click, not the one the agent happens to
    // be bound to now: an open_id only means something inside its own app.
    return handleCardAction(event, entry.binding.appId).catch((error: unknown) => {
      console.error("[feishu] failed to handle a card action:", error);
      return { toast: { type: "error", content: "处理失败，请在 AgentMeld 网页操作。" } };
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

  channel.on("botAdded", (event: BotAddedEvent) => {
    // This bot was just added to (or re-added to) a chat, so the chat's
    // membership has changed. Feishu sends no counterpart for a bot LEAVING a
    // group this bot is still in, so this is the one moment a departure becomes
    // visible: ask who is actually there and drop the agents that are not.
    void (async () => {
      try {
        const channelConversation = getChannelConversationByChat("feishu", event.chatId);
        if (!channelConversation) return;
        // Being added is evidence about OURSELVES, and it is the only such
        // evidence we get without a mention.
        joinChannelConversation(channelConversation, binding.agentId, Date.now());
        const removed = await syncChatMembership(channel, channelConversation.id, event.chatId);
        if (removed.length > 0) {
          console.info(
            `[feishu] ${event.chatId}: dropped ${removed.length} agent(s) no longer in the group`
          );
        }
      } catch (error) {
        console.error("[feishu] failed to reconcile the chat's members:", error);
      }
    })();
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
    source: "agentmeld",
    // A persistent cache, shared by every channel. The SDK's dedup marks every
    // message id in a batch as seen; its own cache is in memory, so without
    // this the marks are lost on restart and a redelivery batched differently
    // is claimed under a different representative id and routed again. The
    // dedup key carries no app id, so a shared cache is also what makes two
    // bots receiving one human message deduplicate against each other.
    cache: getPersistentCache(),
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
    connectedAt: null,
    // Stamped by the caller once the attempt is over, so a failure and a
    // success are cooled down the same way.
    lastAttemptAt: 0
  };

  wireHandlers(entry, channel);
  await connectWithTimeout(entry, channel);
  entry.connectedAt = Date.now();

  try {
    const identity = channel.getBotIdentity();
    entry.botOpenId = identity.openId;
    entry.botName = identity.name;
    // Persisted because routing needs to map a mentioned open id back to an
    // agent, and the registry that knows it is per-process and empty until a
    // connection succeeds.
    setChannelBindingBotOpenId(binding.id, identity.openId);
  } catch (error) {
    // The connection is up; only the identity lookup failed. Not fatal, and
    // worth recording rather than failing the whole start.
    entry.lastError = `identity unavailable: ${error instanceof Error ? error.message : String(error)}`;
  }

  publishConnection(binding, "connected");
  return entry;
}

/**
 * `connect()` with a ceiling.
 *
 * If the attempt finishes after we have given up on it, the channel is
 * disconnected rather than registered: a live connection nobody tracks would
 * receive events and split them away from a future attempt, which is exactly
 * the hazard the app-keyed registry exists to prevent.
 */
async function connectWithTimeout(entry: ConnectionEntry, channel: LarkChannel): Promise<void> {
  const attempt = channel.connect();
  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    await Promise.race([
      attempt,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`connect timed out after ${CONNECT_TIMEOUT_MS}ms`)),
          CONNECT_TIMEOUT_MS
        );
      })
    ]);
  } catch (error) {
    void attempt
      .then(() => channel.disconnect())
      .catch(() => {
        // The attempt failed too; nothing to close.
      });
    entry.channel = null;
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
  }
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
    const epochAtStart = getStopEpoch();
    const now = Date.now();

    const bindings = listFeishuBindings();

    // Drop connections whose binding has gone. A removal that happened while
    // this process was not looking (another process, or a failed disconnect)
    // would otherwise leave a bot speaking for an agent nobody bound any more.
    const live = new Set(bindings.map((binding) => binding.appId));
    for (const appId of [...registry.keys()]) {
      if (!live.has(appId)) await disconnectFeishuApp(appId);
    }

    for (const binding of bindings) {
      const existing = registry.get(binding.appId);
      // A live entry is left alone. A FAILED entry is retried, but not sooner
      // than the cooldown: otherwise every page load that reads the status
      // endpoint would launch another attempt against an app that is known bad.
      if (existing) {
        if (existing.status !== "error") continue;
        if (now - existing.lastAttemptAt < RETRY_COOLDOWN_MS) continue;
      }

      const fail = (reason: string, staleChannel: LarkChannel | null = null) => {
        const entry: ConnectionEntry = {
          binding,
          channel: null,
          // Kept, not dropped: a close that failed leaves a socket that may
          // still be live, and discarding the only handle to it means no later
          // retry can ever close it. It is not `channel`, so nothing will try to
          // send on it in the meantime.
          staleChannel: staleChannel ?? existing?.staleChannel ?? null,
          status: "error",
          botOpenId: null,
          botName: null,
          lastError: reason,
          connectedAt: null,
          lastAttemptAt: Date.now()
        };
        // Recorded, not just announced: the failure has to be readable from the
        // status endpoint afterwards. A startup failure used to exist only as an
        // event, which no client was subscribed to yet.
        registry.set(binding.appId, entry);
        publishConnection(binding, "error", reason);
      };

      // A FAILED entry is retried, and its old channel may still be alive: the
      // error path records the failure without disconnecting, and the SDK can
      // keep reconnecting on its own. Connecting a second socket for the same
      // app would split its events (the hazard §3 describes), so the old one is
      // closed FIRST — before anything below can return early, including the
      // missing-secret check, or the old socket would be orphaned with no
      // reference left to close it.
      //
      // It leaves the registry before the close, so nothing is handed a channel
      // that is being torn down; the app is briefly absent from the status list
      // instead, which is the safe direction (a send is skipped rather than
      // attempted on a dying socket).
      const stale = existing?.channel ?? existing?.staleChannel ?? null;
      if (stale) {
        registry.delete(binding.appId);
        try {
          await stale.disconnect();
        } catch (error) {
          // A close that failed means the old socket may still be live; making a
          // second one would be exactly the hazard this block exists for. Report
          // and leave the app on the error list — WITH the handle, so the next
          // cooldown's retry can try to close it again.
          console.error("[feishu] failed to disconnect a stale connection:", error);
          fail(
            `could not close the previous connection: ${error instanceof Error ? error.message : String(error)}`,
            stale
          );
          continue;
        }
      }

      const secret = getChannelBindingSecret(binding.id);
      if (!secret) {
        fail("missing app secret");
        continue;
      }

      try {
        const entry = await connectOne(binding, secret);
        entry.lastAttemptAt = Date.now();
        if (epochAtStart !== getStopEpoch()) {
          // A stop happened while this was connecting. Closing it is the whole
          // point of the epoch; registering it would make stop a lie.
          await entry.channel?.disconnect().catch(() => {});
          continue;
        }
        registry.set(binding.appId, entry);
      } catch (error) {
        fail(error instanceof Error ? error.message : String(error));
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

/**
 * Close one app's connection and forget it.
 *
 * Called when a binding is removed. Without it, unbinding deleted the row while
 * the connection kept running, so the agent carried on speaking in the group as
 * itself until the process restarted — the opposite of "no connection, no
 * voice".
 */
export async function disconnectFeishuApp(appId: string): Promise<boolean> {
  const registry = getRegistry();
  const entry = registry.get(appId);
  if (!entry) return false;
  registry.delete(appId);
  try {
    await entry.channel?.disconnect();
  } catch {
    // The row is gone either way; a failed close is not actionable.
  }
  publishConnection(entry.binding, "disconnected");
  return true;
}

/**
 * Close every connection. Safe to call when nothing is connected.
 *
 * The epoch is bumped FIRST: an attempt already in flight checks it before
 * registering, so a stop cannot be undone by a connect that lands afterwards.
 */
export async function stopFeishuChannels(): Promise<void> {
  globalThis.__agentMeldFeishuStopEpoch = getStopEpoch() + 1;
  const registry = getRegistry();
  const entries = [...registry.values()];
  registry.clear();
  await Promise.all(
    entries.map(async (entry) => {
      try {
        await entry.channel?.disconnect();
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


