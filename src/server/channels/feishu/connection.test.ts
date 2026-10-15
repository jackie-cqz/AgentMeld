import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setupTestDatabase } from "@/test/test-database";
import { resetFeishuConnectionsForTests } from "@/server/channels/feishu/connection";
import { unbindAgent } from "@/server/channels/feishu/binding";
import { getDatabase } from "@/db/client";
import {
  addChannelConversationMember,
  createChannelConversation,
  createConversation,
  listChannelConversationMembers,
  upsertChannelBinding
} from "@/server/repositories";
import { eventBus, type EventBusEntry } from "@/server/event-bus";
import type { StreamEvent } from "@/shared/types";

/**
 * The connection layer's job is narrow: hold one connection per bound app,
 * report its health, and publish what arrives. These tests pin the two things
 * that are easy to get wrong — opening a duplicate connection for an app (the
 * platform splits that app's events across both) and ever replying to an
 * inbound message, which is the primary loop defence.
 */

const { createLarkChannelMock } = vi.hoisted(() => ({ createLarkChannelMock: vi.fn() }));

vi.mock("@larksuite/channel", () => ({
  createLarkChannel: createLarkChannelMock
}));

import {
  getFeishuChannelForAgent,
  listFeishuConnections,
  startFeishuChannels,
  stopFeishuChannels
} from "@/server/channels/feishu/connection";

type Handler = (payload: unknown) => void;

interface FakeChannel {
  options: Record<string, unknown>;
  handlers: Map<string, Handler[]>;
  connect: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  send: ReturnType<typeof vi.fn>;
  getChatBots: ReturnType<typeof vi.fn>;
  getBotIdentity: ReturnType<typeof vi.fn>;
  on: (event: string, handler: Handler) => void;
  emit: (event: string, payload: unknown) => void;
}

let created: FakeChannel[] = [];
let connectBehavior: (appId: string) => "ok" | "fail" | "hang" | "deferred";
/** Resolvers for channels created while `connectBehavior` returns "deferred". */
let pendingConnects: Array<() => void> = [];

function makeChannel(options: Record<string, unknown>): FakeChannel {
  const handlers = new Map<string, Handler[]>();
  const channel: FakeChannel = {
    options,
    handlers,
    connect: vi.fn(async () => {
      const behavior = connectBehavior(String(options.appId));
      if (behavior === "fail") throw new Error("connect refused");
      if (behavior === "hang") {
        // Never settles: the case the per-app timeout exists for.
        await new Promise<never>(() => {});
      }
      if (behavior === "deferred") {
        // Resolves only when the test says so, which is how a stop can land
        // while a connect is still in flight.
        await new Promise<void>((resolve) => pendingConnects.push(resolve));
      }
    }),
    disconnect: vi.fn(async () => {}),
    getChatBots: vi.fn(async () => []),
    // If anything ever calls this, the loop defence has been broken.
    send: vi.fn(async () => ({ messageId: "om_should_not_happen" })),
    getBotIdentity: vi.fn(() => ({
      openId: `ou_${String(options.appId)}`,
      name: `Bot ${String(options.appId)}`
    })),
    on(event, handler) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    emit(event, payload) {
      for (const handler of handlers.get(event) ?? []) handler(payload);
    }
  };
  created.push(channel);
  return channel;
}

function seedBinding(agentId: string, appId: string, id = `cb_${agentId}`): void {
  // `channel_bindings.agent_id` is a foreign key, so these must be real agents
  // — the ids below are the ones bootstrap seeds.
  upsertChannelBinding({
    id,
    agentId,
    channel: "feishu",
    appId,
    appSecret: `secret_${appId}`,
    now: Date.now()
  });
}

function collectEvents(): { events: StreamEvent[]; stop: () => void } {
  const events: StreamEvent[] = [];
  const stop = eventBus.subscribe((entry: EventBusEntry) => events.push(entry.event));
  return { events, stop };
}

describe("feishu connection layer", () => {
  let teardown: () => void;

  beforeEach(() => {
    teardown = setupTestDatabase("agentmeld-feishu-connection-");
    created = [];
    connectBehavior = () => "ok";
    pendingConnects = [];
    createLarkChannelMock.mockReset();
    createLarkChannelMock.mockImplementation((options: Record<string, unknown>) =>
      makeChannel(options)
    );
    resetFeishuConnectionsForTests();
  });

  afterEach(() => {
    resetFeishuConnectionsForTests();
    teardown();
  });

  it("connects one channel per bound app and reports it as connected", async () => {
    seedBinding("ag_pm", "cli_a");
    seedBinding("ag_designer", "cli_b");

    const infos = await startFeishuChannels();

    expect(createLarkChannelMock).toHaveBeenCalledTimes(2);
    expect(infos).toHaveLength(2);
    expect(infos.map((info) => info.appId).sort()).toEqual(["cli_a", "cli_b"]);
    for (const info of infos) {
      expect(info.status).toBe("connected");
      expect(info.botName).toBe(`Bot ${info.appId}`);
      expect(info.connectedAt).toBeTypeOf("number");
    }
  });

  it("never opens a second connection for the same app", async () => {
    // Two connections to one app silently split its events, so this has to be
    // structurally impossible rather than a rule someone remembers.
    seedBinding("ag_pm", "cli_shared");
    seedBinding("ag_designer", "cli_shared", "cb_designer");

    await startFeishuChannels();
    await startFeishuChannels();

    expect(createLarkChannelMock).toHaveBeenCalledTimes(1);
    expect(listFeishuConnections()).toHaveLength(1);
  });

  it("shares one run between concurrent starts", async () => {
    seedBinding("ag_pm", "cli_a");

    const [first, second] = await Promise.all([startFeishuChannels(), startFeishuChannels()]);

    expect(createLarkChannelMock).toHaveBeenCalledTimes(1);
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
  });

  it("sets the policy that keeps a bot from answering the whole room, and arms the loop guard", async () => {
    seedBinding("ag_pm", "cli_a");

    await startFeishuChannels();

    const policy = created[0].options.policy as {
      requireMention?: boolean;
      respondToMentionAll?: boolean;
      botLoopGuard?: { enabled?: boolean; onTrip?: string };
    };
    expect(policy.requireMention).toBe(true);
    expect(policy.respondToMentionAll).toBe(false);
    expect(policy.botLoopGuard?.enabled).toBe(true);
    // "reject" rather than "drop" so a trip is visible in our own stream.
    expect(policy.botLoopGuard?.onTrip).toBe("reject");
  });

  it("hands the SDK a persistent cache, so dedup marks outlive the process", async () => {
    // Without it the SDK's own dedup is in memory and every mark is lost on
    // restart — and its marks are what cover a redelivery that happens to be
    // batched differently. Asserting the option exists is not enough, so this
    // also exercises the round trip through the database.
    seedBinding("ag_pm", "cli_a");
    await startFeishuChannels();

    const cache = created[0].options.cache as {
      set: (key: string, value: unknown, expire?: number, opts?: { namespace?: string }) => Promise<boolean>;
      get: (key: string, opts?: { namespace?: string }) => Promise<unknown>;
    };
    expect(cache).toBeDefined();

    await cache.set("om_seen", "1", undefined, { namespace: "channel:seen" });
    expect(await cache.get("om_seen", { namespace: "channel:seen" })).toBe("1");
  });

  it("publishes an inbound event with the trimmed shape and never replies", async () => {
    seedBinding("ag_pm", "cli_a");
    await startFeishuChannels();
    const { events, stop } = collectEvents();
    try {
      created[0].emit("message", {
        messageId: "om_1",
        chatId: "oc_1",
        chatType: "group",
        senderId: "ou_sender",
        senderType: "bot",
        senderIsBot: true,
        content: "hello",
        threadId: "omt_1",
        createTime: 1_700_000_000_000,
        mentionedBot: true,
        // Fields that must NOT leak into the event stream.
        raw: { tenant_key: "tenant_secret", token: "t-secret" },
        mentions: [{ key: "@_user_1", openId: "ou_x" }],
        resources: []
      });
    } finally {
      stop();
    }

    expect(events).toHaveLength(1);
    const event = events[0];
    expect(event.type).toBe("channel.inbound");
    if (event.type !== "channel.inbound") return;

    expect(event.message).toEqual({
      channel: "feishu",
      agentId: "ag_pm",
      chatId: "oc_1",
      chatType: "group",
      messageId: "om_1",
      senderId: "ou_sender",
      senderType: "bot",
      senderIsBot: true,
      mentionedBot: true,
      // Only open ids are carried forward: a mention's display name is set by
      // whoever sent it and is not identity.
      mentionOpenIds: ["ou_x"],
      resources: [],
      content: "hello",
      threadId: "omt_1",
      createTime: 1_700_000_000_000
    });
    // The raw payload holds tenant keys and tokens; it must not ride along.
    expect(JSON.stringify(event)).not.toContain("tenant_secret");
    expect(JSON.stringify(event)).not.toContain("t-secret");

    // §5.8 layer 1: receiving a message must never produce one.
    expect(created[0].send).not.toHaveBeenCalled();
  });

  it("records itself and reconciles the group when it is added to a chat", async () => {
    // The glue around the reconciliation: which chat, who we are, and that a
    // departed member really goes. Removing the self-recording line used to
    // leave the whole suite green.
    seedBinding("ag_pm", "cli_pm");
    const conversation = createConversation({
      id: "conv_1",
      title: "群",
      mode: "group",
      agentIds: ["ag_pm", "ag_designer"],
      fsWriteApprovalMode: "auto",
      now: 1
    });
    createChannelConversation({
      id: "cc_1",
      channel: "feishu",
      chatId: "oc_1",
      conversationId: conversation.id,
      now: 1
    });
    addChannelConversationMember({ channelConversationId: "cc_1", agentId: "ag_designer", now: 1 });
    upsertChannelBinding({
      id: "cb_designer",
      agentId: "ag_designer",
      channel: "feishu",
      appId: "cli_designer",
      appSecret: "s",
      botOpenId: "ou_bot_designer",
      boundByOpenId: "ou_user",
      now: 1
    });

    await startFeishuChannels();
    // Only the designer's bot is in the chat, so the agent we are about to
    // record ourselves as must survive the reconciliation.
    // Two bindings mean two channels: the event must come from the app whose
    // agent we are asserting about, not from whichever was created first.
    const mine = created.find((fake) => fake.options.appId === "cli_pm");
    if (!mine) throw new Error("expected a channel for cli_pm");
    mine.getChatBots.mockResolvedValue([
      { id: "ou_bot_designer", idType: "open_id", name: "D", isBot: true }
    ]);
    mine.emit("botAdded", { chatId: "oc_1", operator: { openId: "ou_user" } });

    await vi.waitFor(() => {
      expect(listChannelConversationMembers("cc_1")).toContain("ag_pm");
    });
    expect(listChannelConversationMembers("cc_1")).toContain("ag_designer");
  });

  it("turns a rejected event into a visible connection event", async () => {
    // This is how a botLoopGuard trip becomes observable instead of silent.
    seedBinding("ag_pm", "cli_a");
    await startFeishuChannels();
    const { events, stop } = collectEvents();
    try {
      created[0].emit("reject", { reason: "bot_loop", chatId: "oc_1" });
    } finally {
      stop();
    }

    const rejection = events.find((event) => event.type === "channel.connection");
    expect(rejection).toBeDefined();
    if (rejection?.type !== "channel.connection") return;
    expect(rejection.reason).toBe("rejected:bot_loop");
  });

  it("keeps going when one app fails to connect", async () => {
    seedBinding("ag_reviewer", "cli_bad");
    seedBinding("ag_mock_builder", "cli_ok");
    connectBehavior = (appId) => (appId === "cli_bad" ? "fail" : "ok");

    const { events, stop } = collectEvents();
    let infos;
    try {
      infos = await startFeishuChannels();
    } finally {
      stop();
    }

    // Both are reported now. An earlier revision listed only the ones that
    // worked, which made a failure indistinguishable from "not asked yet".
    expect(infos?.map((info) => info.appId).sort()).toEqual(["cli_bad", "cli_ok"]);
    expect(infos?.find((info) => info.appId === "cli_bad")?.status).toBe("error");
    const failure = events.find(
      (event) => event.type === "channel.connection" && event.status === "error"
    );
    expect(failure).toBeDefined();
    if (failure?.type !== "channel.connection") return;
    expect(failure.appId).toBe("cli_bad");
    expect(failure.reason).toBe("connect refused");
  });

  it("resolves the channel for an agent and returns null for an unbound one", async () => {
    seedBinding("ag_pm", "cli_a");
    seedBinding("ag_designer", "cli_b");
    await startFeishuChannels();

    expect(getFeishuChannelForAgent("ag_pm")).toBe(created[0]);
    // An unbound agent must read as "no Feishu presence", never as "someone
    // else's bot" — that would destroy the per-agent identity this is for.
    expect(getFeishuChannelForAgent("ag_nonexistent")).toBeNull();
  });

  it("disconnects everything and clears the registry", async () => {
    seedBinding("ag_pm", "cli_a");
    await startFeishuChannels();

    await stopFeishuChannels();

    expect(created[0].disconnect).toHaveBeenCalledTimes(1);
    expect(listFeishuConnections()).toHaveLength(0);
  });

  it("keeps a failed app in the status list instead of letting it read as unknown", async () => {
    // A failure that existed only as an event was invisible to any client that
    // was not already subscribed when it happened — and a startup failure
    // happens before anyone is. "Could not connect" and "we have not asked yet"
    // must not look the same.
    seedBinding("ag_reviewer", "cli_bad");
    connectBehavior = () => "fail";

    const infos = await startFeishuChannels();

    const failed = infos.find((info) => info.appId === "cli_bad");
    expect(failed?.status).toBe("error");
    expect(failed?.lastError).toBe("connect refused");
    // And it is not handed out as a usable channel.
    expect(getFeishuChannelForAgent("ag_reviewer")).toBeNull();
  });

  it("closes the old socket before reconnecting an app that errored", async () => {
    // A live channel that reports `error` keeps its status AND its channel
    // object. Reconnecting without closing it first would leave two sockets for
    // one app — the event-splitting hazard this layer exists to prevent.
    seedBinding("ag_reviewer", "cli_bad");
    await startFeishuChannels();
    expect(createLarkChannelMock).toHaveBeenCalledTimes(1);

    // The channel reports an error while it is still connected.
    created[0].emit("error", new Error("socket wobble"));

    vi.useFakeTimers();
    try {
      vi.setSystemTime(Date.now() + 60_000);
      await startFeishuChannels();
    } finally {
      vi.useRealTimers();
    }

    // The stale socket was closed before the replacement was created — the
    // ORDER is the whole point: closing after connecting leaves two sockets for
    // one app, which is the hazard this layer exists to prevent.
    const stale = created[0];
    expect(stale.disconnect).toHaveBeenCalledTimes(1);
    expect(createLarkChannelMock).toHaveBeenCalledTimes(2);
    expect(stale.disconnect.mock.invocationCallOrder[0]).toBeLessThan(
      createLarkChannelMock.mock.invocationCallOrder[1]
    );
  });

  it("does not retry a failed app on every read, but does retry it later", async () => {
    // The status route nudges a reconnect, so without a cooldown every page
    // load would launch another attempt at an app known to be bad.
    seedBinding("ag_reviewer", "cli_bad");
    connectBehavior = () => "fail";
    await startFeishuChannels();
    expect(createLarkChannelMock).toHaveBeenCalledTimes(1);

    await startFeishuChannels();
    expect(createLarkChannelMock).toHaveBeenCalledTimes(1);

    // Past the cooldown it is worth another try.
    vi.useFakeTimers();
    try {
      vi.setSystemTime(Date.now() + 60_000);
      await startFeishuChannels();
    } finally {
      vi.useRealTimers();
    }
    expect(createLarkChannelMock).toHaveBeenCalledTimes(2);
  });

  it("does not make a second socket when the old one will not close", async () => {
    // A close that failed means the old socket may still be live; connecting
    // anyway would be the two-socket hazard.
    seedBinding("ag_reviewer", "cli_bad");
    await startFeishuChannels();
    created[0].emit("error", new Error("socket wobble"));
    created[0].disconnect.mockRejectedValueOnce(new Error("close failed"));

    vi.useFakeTimers();
    try {
      vi.setSystemTime(Date.now() + 60_000);
      await startFeishuChannels();
    } finally {
      vi.useRealTimers();
    }

    expect(createLarkChannelMock).toHaveBeenCalledTimes(1);
  });

  it("retries closing a socket it failed to close, on the next cooldown", async () => {
    // Dropping the handle when a close fails means no later attempt can ever
    // close that socket, and the next retry happily opens a second one beside
    // it — the hazard this whole block exists for.
    seedBinding("ag_reviewer", "cli_bad");
    await startFeishuChannels();
    created[0].emit("error", new Error("socket wobble"));
    created[0].disconnect.mockRejectedValueOnce(new Error("close failed"));

    vi.useFakeTimers();
    try {
      vi.setSystemTime(Date.now() + 60_000);
      await startFeishuChannels();
      // The close failed: no second socket, and the handle is retained.
      expect(createLarkChannelMock).toHaveBeenCalledTimes(1);

      vi.setSystemTime(Date.now() + 120_000);
      await startFeishuChannels();
    } finally {
      vi.useRealTimers();
    }

    // The next round closed it (second disconnect call) before connecting.
    expect(created[0].disconnect).toHaveBeenCalledTimes(2);
    expect(createLarkChannelMock).toHaveBeenCalledTimes(2);
  });

  it("gives up on an app that never answers, so the others still connect", async () => {
    // The SDK times out the WebSocket handshake but not the HTTP calls that
    // come first, so a black-hole host would otherwise hold the whole start
    // open — and every later app with it.
    seedBinding("ag_reviewer", "cli_hang");
    seedBinding("ag_mock_builder", "cli_ok", "cb_builder");
    connectBehavior = (appId) => (appId === "cli_hang" ? "hang" : "ok");

    vi.useFakeTimers();
    let infos: Awaited<ReturnType<typeof startFeishuChannels>>;
    try {
      const run = startFeishuChannels();
      await vi.advanceTimersByTimeAsync(25_000);
      infos = await run;
    } finally {
      vi.useRealTimers();
    }

    const hung = infos.find((info) => info.appId === "cli_hang");
    expect(hung?.status).toBe("error");
    expect(hung?.lastError).toContain("timed out");
    // The healthy app was reached despite the hung one coming first.
    expect(infos.find((info) => info.appId === "cli_ok")?.status).toBe("connected");
  });

  it("does not let a connect that lands after a stop leave a live connection", async () => {
    // stop() clears the registry, so a connect finishing afterwards would
    // register a connection nothing would ever close — and it would quietly
    // split that app's events.
    seedBinding("ag_pm", "cli_slow");
    connectBehavior = () => "deferred";

    const run = startFeishuChannels();
    await Promise.resolve();
    const stop = stopFeishuChannels();
    pendingConnects.forEach((resolve) => resolve());
    await Promise.all([run, stop]);

    expect(listFeishuConnections()).toHaveLength(0);
    expect(created[0].disconnect).toHaveBeenCalled();
  });

  it("stops speaking for an agent whose binding is removed", async () => {
    // Unbinding used to delete the row and leave the connection running, so the
    // agent carried on posting in the group as itself until the process
    // restarted. That is the opposite of "no connection, no voice".
    seedBinding("ag_pm", "cli_a");
    await startFeishuChannels();
    expect(getFeishuChannelForAgent("ag_pm")).not.toBeNull();

    unbindAgent("ag_pm");
    // The close is kicked off from a synchronous function, so let it land.
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(created[0].disconnect).toHaveBeenCalled();
    expect(getFeishuChannelForAgent("ag_pm")).toBeNull();
    expect(listFeishuConnections()).toHaveLength(0);
  });

  it("drops a connection whose binding has gone, on the next start", async () => {
    // The backstop for a removal this process did not perform.
    seedBinding("ag_pm", "cli_a");
    await startFeishuChannels();

    getDatabase().prepare("DELETE FROM channel_bindings").run();
    await startFeishuChannels();

    expect(created[0].disconnect).toHaveBeenCalled();
    expect(listFeishuConnections()).toHaveLength(0);
  });

  it("allows reconnecting after a stop", async () => {
    seedBinding("ag_pm", "cli_a");
    await startFeishuChannels();
    await stopFeishuChannels();

    const infos = await startFeishuChannels();

    expect(createLarkChannelMock).toHaveBeenCalledTimes(2);
    expect(infos).toHaveLength(1);
  });
});
