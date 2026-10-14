import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setupTestDatabase } from "@/test/test-database";
import { resetFeishuConnectionsForTests } from "@/server/channels/feishu/connection";
import { upsertChannelBinding } from "@/server/repositories";
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
  getBotIdentity: ReturnType<typeof vi.fn>;
  on: (event: string, handler: Handler) => void;
  emit: (event: string, payload: unknown) => void;
}

let created: FakeChannel[] = [];
let connectBehavior: (appId: string) => "ok" | "fail";

function makeChannel(options: Record<string, unknown>): FakeChannel {
  const handlers = new Map<string, Handler[]>();
  const channel: FakeChannel = {
    options,
    handlers,
    connect: vi.fn(async () => {
      if (connectBehavior(String(options.appId)) === "fail") {
        throw new Error("connect refused");
      }
    }),
    disconnect: vi.fn(async () => {}),
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

    expect(infos?.map((info) => info.appId)).toEqual(["cli_ok"]);
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

  it("allows reconnecting after a stop", async () => {
    seedBinding("ag_pm", "cli_a");
    await startFeishuChannels();
    await stopFeishuChannels();

    const infos = await startFeishuChannels();

    expect(createLarkChannelMock).toHaveBeenCalledTimes(2);
    expect(infos).toHaveLength(1);
  });
});
