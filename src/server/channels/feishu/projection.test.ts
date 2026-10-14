import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setupTestDatabase } from "@/test/test-database";
import {
  isChannelProjectionPaused,
  projectableText,
  projectMessage,
  setChannelProjectionPaused,
  startChannelProjection,
  stopChannelProjectionForTests,
  withinSendBudget
} from "@/server/channels/feishu/projection";
import { eventBus } from "@/server/event-bus";
import {
  createChannelConversation,
  createConversation,
  createMessage
} from "@/server/repositories";
import type { Message, MessagePart, MessageStatus } from "@/shared/types";

/**
 * `getFeishuChannelForAgent` is stubbed: this suite is about WHICH channel a
 * message is routed to and WHETHER it goes, not about the platform client.
 */
const { channelsByAgent, sent } = vi.hoisted(() => ({
  channelsByAgent: new Map<string, { send: (chatId: string, input: unknown) => Promise<unknown> }>(),
  sent: [] as Array<{ agentId: string; chatId: string; input: unknown }>
}));

vi.mock("@/server/channels/feishu/connection", () => ({
  getFeishuChannelForAgent: (agentId: string) => {
    const channel = channelsByAgent.get(agentId);
    if (!channel) return null;
    return {
      send: (chatId: string, input: unknown) => {
        sent.push({ agentId, chatId, input });
        return channel.send(chatId, input);
      }
    };
  }
}));

function agentMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: "msg_1",
    conversationId: "conv_1",
    role: "agent",
    origin: "internal",
    agentId: "ag_pm",
    runId: "run_1",
    parts: [{ type: "text", content: "这是结论" }],
    status: "complete",
    mentionedAgentIds: [],
    parentMessageId: null,
    createdAt: 1,
    updatedAt: 1,
    ...overrides
  };
}

describe("projectableText", () => {
  it("keeps the answer", () => {
    expect(projectableText([{ type: "text", content: "结论" }])).toBe("结论");
  });

  it("keeps code and artifact references", () => {
    const text = projectableText([
      { type: "text", content: "见下" },
      { type: "code", content: "const a = 1;" },
      { type: "artifact_ref", artifactId: "a1", title: "登录页" }
    ]);
    expect(text).toContain("见下");
    expect(text).toContain("const a = 1;");
    expect(text).toContain("登录页");
  });

  it("leaves reasoning and tool traffic on the web", () => {
    // The group should see conclusions, not a transcript.
    const text = projectableText([
      { type: "thinking", content: "让我想想" },
      { type: "tool_use", callId: "c1", toolName: "bash", args: { command: "ls" } },
      { type: "tool_result", callId: "c1", result: "a b c" }
    ]);
    expect(text).toBe("");
  });

  it("ignores whitespace-only parts", () => {
    expect(projectableText([{ type: "text", content: "   \n  " }])).toBe("");
  });
});

describe("withinSendBudget", () => {
  let teardown: () => void;

  beforeEach(() => {
    teardown = setupTestDatabase("agentmeld-channel-budget-");
    sent.length = 0;
    channelsByAgent.clear();
    stopChannelProjectionForTests();
    channelsByAgent.set("ag_pm", { send: async () => ({ messageId: "om_out" }) });
    for (const id of ["conv_1", "conv_2"]) {
      createConversation({
        id,
        title: id,
        mode: "group",
        agentIds: ["ag_pm"],
        fsWriteApprovalMode: "auto",
        now: 1
      });
      createChannelConversation({
        id: `cc_${id}`,
        channel: "feishu",
        chatId: `oc_${id}`,
        conversationId: id,
        now: 1
      });
    }
  });

  afterEach(() => {
    stopChannelProjectionForTests();
    teardown();
  });

  // Driven through the real send path rather than by poking the counter, so the
  // limit is exercised the way it will actually be hit.
  const sendOnce = (conversationId: string, now: number) =>
    projectMessage(agentMessage({ conversationId, id: `msg_${now}_${conversationId}` }), now);

  it("allows sends up to the window limit and then refuses", async () => {
    const now = 1_000_000;
    for (let i = 0; i < 20; i += 1) {
      expect((await sendOnce("conv_1", now)).status).toBe("sent");
    }
    expect(await sendOnce("conv_1", now)).toEqual({
      status: "skipped",
      reason: "send budget exhausted"
    });
    // The helper's own view agrees with what the sends did.
    expect(withinSendBudget("conv_1", now)).toBe(false);
  });

  it("forgets sends that fell out of the window", async () => {
    const now = 1_000_000;
    for (let i = 0; i < 20; i += 1) await sendOnce("conv_1", now);
    expect((await sendOnce("conv_1", now + 120_000)).status).toBe("sent");
  });

  it("counts each conversation separately", async () => {
    const now = 1_000_000;
    for (let i = 0; i < 20; i += 1) await sendOnce("conv_1", now);
    expect((await sendOnce("conv_2", now)).status).toBe("sent");
  });
});

describe("projectMessage", () => {
  let teardown: () => void;

  beforeEach(() => {
    teardown = setupTestDatabase("agentmeld-channel-projection-");
    sent.length = 0;
    channelsByAgent.clear();
    stopChannelProjectionForTests();

    createConversation({
      id: "conv_1",
      title: "飞书群",
      mode: "group",
      agentIds: ["ag_pm"],
      fsWriteApprovalMode: "auto",
      now: 1
    });
  });

  afterEach(() => {
    stopChannelProjectionForTests();
    teardown();
  });

  function linkChat(chatId = "oc_1") {
    createChannelConversation({
      id: "cc_1",
      channel: "feishu",
      chatId,
      conversationId: "conv_1",
      now: 1
    });
  }

  function connect(agentId: string) {
    channelsByAgent.set(agentId, { send: async () => ({ messageId: "om_out" }) });
  }

  it("posts agent output through that agent's own bot", async () => {
    linkChat();
    connect("ag_pm");

    const outcome = await projectMessage(agentMessage());

    expect(outcome.status).toBe("sent");
    expect(sent).toHaveLength(1);
    expect(sent[0].agentId).toBe("ag_pm");
    expect(sent[0].chatId).toBe("oc_1");
    expect((sent[0].input as { text: string }).text).toBe("这是结论");
  });

  it("stays silent rather than borrowing another agent's bot", async () => {
    // Per-agent identity is the reason to bind one app per agent; posting under
    // the wrong name would defeat the feature rather than degrade it.
    linkChat();
    connect("ag_designer");

    const outcome = await projectMessage(agentMessage());

    expect(outcome.status).toBe("skipped");
    expect(sent).toHaveLength(0);
  });

  it("ignores a conversation that is not on a channel", async () => {
    connect("ag_pm");
    const outcome = await projectMessage(agentMessage());

    expect(outcome).toEqual({ status: "skipped", reason: "conversation is not on a channel" });
    expect(sent).toHaveLength(0);
  });

  it("does not project a human's own message", async () => {
    // It is already where the human put it, and there is no bot that could
    // deliver it as itself.
    linkChat();
    connect("ag_pm");

    const outcome = await projectMessage(agentMessage({ role: "user", agentId: null }));

    expect(outcome.status).toBe("skipped");
    expect(sent).toHaveLength(0);
  });

  it("sends nothing when an agent produced nothing for the room", async () => {
    linkChat();
    connect("ag_pm");

    const parts: MessagePart[] = [
      { type: "tool_use", callId: "c1", toolName: "bash", args: {} }
    ];
    const outcome = await projectMessage(agentMessage({ parts }));

    expect(outcome).toEqual({ status: "skipped", reason: "nothing projectable" });
    expect(sent).toHaveLength(0);
  });

  it("stops at the budget and says so once rather than silently swallowing output", async () => {
    linkChat();
    connect("ag_pm");
    const now = Date.now();
    // Spend the window through the real path first.
    for (let i = 0; i < 20; i += 1) {
      await projectMessage(agentMessage({ id: `msg_fill_${i}` }), now);
    }

    const first = await projectMessage(agentMessage({ id: "msg_over_1" }), now);
    const second = await projectMessage(agentMessage({ id: "msg_over_2" }), now);

    expect(first).toEqual({ status: "skipped", reason: "send budget exhausted" });
    // The 20 real sends, then exactly one notice — not one per suppressed
    // message.
    expect(sent).toHaveLength(21);
    expect((sent[20].input as { text: string }).text).toContain("消息过多");
    expect(second.status).toBe("skipped");
    expect(sent).toHaveLength(21);
  });

  it("can be paused without affecting anything else", async () => {
    linkChat();
    connect("ag_pm");

    setChannelProjectionPaused(true);
    expect(isChannelProjectionPaused()).toBe(true);
    const outcome = await projectMessage(agentMessage());

    expect(outcome).toEqual({ status: "skipped", reason: "paused" });
    expect(sent).toHaveLength(0);
  });
});

describe("startChannelProjection", () => {
  let teardown: () => void;

  beforeEach(() => {
    teardown = setupTestDatabase("agentmeld-channel-projection-sub-");
    sent.length = 0;
    channelsByAgent.clear();
    stopChannelProjectionForTests();

    createConversation({
      id: "conv_1",
      title: "飞书群",
      mode: "group",
      agentIds: ["ag_pm"],
      fsWriteApprovalMode: "auto",
      now: 1
    });
    createChannelConversation({
      id: "cc_1",
      channel: "feishu",
      chatId: "oc_1",
      conversationId: "conv_1",
      now: 1
    });
    channelsByAgent.set("ag_pm", { send: async () => ({ messageId: "om_out" }) });
  });

  afterEach(() => {
    stopChannelProjectionForTests();
    teardown();
  });

  /** Insert a message the way the runner does, and finish it. */
  function finishedMessage(options: {
    role: "agent" | "user";
    agentId: string | null;
    status?: MessageStatus;
  }) {
    const message = createMessage({
      id: `msg_${Math.random().toString(36).slice(2, 8)}`,
      conversationId: "conv_1",
      role: options.role,
      agentId: options.agentId,
      parts: [{ type: "text", content: "这是结论" }],
      status: "complete",
      now: 1
    });
    eventBus.publish({
      type: "message.end",
      conversationId: "conv_1",
      timestamp: 2,
      messageId: message.id,
      status: options.status ?? "complete"
    });
    return message;
  }

  it("posts an agent's answer once it ends", async () => {
    startChannelProjection();
    finishedMessage({ role: "agent", agentId: "ag_pm" });
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(sent).toHaveLength(1);
    expect((sent[0].input as { text: string }).text).toBe("这是结论");
  });

  it("does not post on message.added, which is not how an answer finishes", async () => {
    // The bug this pins: an agent's answer is created with `message.start` and
    // finished with `message.end`. It is never published as `message.added`, so
    // subscribing to that meant the projection never ran at all — and the tests
    // did not catch it because they published the event the code expected.
    startChannelProjection();
    eventBus.publish({
      type: "message.added",
      conversationId: "conv_1",
      timestamp: 1,
      message: agentMessage()
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(sent).toHaveLength(0);
  });

  it("does not post a reply that ended badly", async () => {
    startChannelProjection();
    finishedMessage({ role: "agent", agentId: "ag_pm", status: "error" });
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(sent).toHaveLength(0);
  });

  it("does not post a human's message", async () => {
    startChannelProjection();
    finishedMessage({ role: "user", agentId: null });
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(sent).toHaveLength(0);
  });

  it("returns the same subscription when started twice", () => {
    const first = startChannelProjection();
    const second = startChannelProjection();
    expect(second).toBe(first);
  });
});
