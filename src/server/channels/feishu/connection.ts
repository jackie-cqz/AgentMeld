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

interface ConnectionEntry {
  binding: ChannelBinding;
  /** `null` on a failed attempt: the entry exists to REPORT the failure. */
  channel: LarkChannel | null;
  status: ChannelConnectionStatus;
  botOpenId: string | null;
  botName: string | null;
  lastError: string | null;
  connectedAt: number | null;
  /** When this app was last attempted, so a failure is not retried in a loop. */
  lastAttemptAt: number;
}

declare global {
  var __agentMeldFeishuConnections: Map<string, ConnectionEntry> | undefined;
  var __agentMeldFeishuStarting: Promise<ChannelConnectionInfo[]> | undefined;
  /**
   * Bumped by every `stop`. A start that began before a stop must not register
   * its connection afterwards — otherwise stopping during a connect would leave
   * a live connection nothing holds a reference to, which is worse than either
   * outcome on its own.
   */
  var __agentMeldFeishuStopEpoch: number | undefined;
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

function getStopEpoch(): number {
  globalThis.__agentMeldFeishuStopEpoch ??= 0;
  return globalThis.__agentMeldFeishuStopEpoch;
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

      const fail = (reason: string) => {
        const entry: ConnectionEntry = {
          binding,
          channel: null,
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
export function getFeishuChannelForAgent(agentId: string): LarkChannel | null {
  for (const entry of getRegistry().values()) {
    if (entry.binding.agentId === agentId && entry.channel) return entry.channel;
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
  globalThis.__agentMeldFeishuStopEpoch = undefined;
}
