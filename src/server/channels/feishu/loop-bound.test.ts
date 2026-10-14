import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setupTestDatabase } from "@/test/test-database";
import { eventBus } from "@/server/event-bus";
import {
  startChannelProjection,
  stopChannelProjectionForTests,
  setChannelProjectionPaused
} from "@/server/channels/feishu/projection";
import {
  startChannelRouter,
  stopChannelRouterForTests
} from "@/server/channels/feishu/router";
import {
  createMessage,
  getChannelConversationByChat,
  listMessages,
  setChannelBindingBotOpenId,
  upsertChannelBinding
} from "@/server/repositories";
import type { ChannelInboundMessage } from "@/shared/types";

/**
 * The acceptance test design §5.8 has been promising and never had: two bots in
 * one group, each @-ing the other, and the assertion is that the number of
 * messages is BOUNDED and the exchange STOPS.
 *
 * It is written as an integration test on purpose. Every layer has its own unit
 * tests with stubs, and each of those passed while the feature was broken in
 * production — because a stub lets a test supply exactly the input the code
 * expects. Here the router, the projection and the event bus are the real ones.
 * TWO things are faked, and it is worth being exact about them: the platform
 * client, and `startAgentRun` (so a "run" is a counted event rather than a
 * model call).
 *
 * Which layers this covers, stated rather than implied — the review found it
 * was being described as covering more than it does:
 *   - layer 1 (inbound never produces outbound): yes, in the wiring.
 *   - layer 3 (the origin gate): yes — removing it makes this fail.
 *   - layer 6 (botLoopGuard): NO. The connection module is mocked here, so the
 *     policy it arms is not exercised; `connection.test.ts` asserts that.
 */
const { channelsByAgent, sent } = vi.hoisted(() => ({
  channelsByAgent: new Map<string, unknown>(),
  sent: [] as Array<{ agentId: string; chatId: string; text: string }>
}));

vi.mock("@/server/channels/feishu/registry", () => ({
  getFeishuChannelForAgent: (agentId: string) => {
    const channel = channelsByAgent.get(agentId);
    if (!channel) return null;
    return {
      send: async (chatId: string, input: { text: string }) => {
        sent.push({ agentId, chatId, text: input.text });
        return { messageId: `om_${sent.length}` };
      }
    };
  }
}));

/** `startAgentRun` is stubbed so a "run" is a counted event, not a model call. */
const { startAgentRunMock } = vi.hoisted(() => ({ startAgentRunMock: vi.fn() }));
vi.mock("@/server/agent-runner", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/agent-runner")>();
  return {
    ...actual,
    startAgentRun: (...args: unknown[]) => startAgentRunMock(...args)
  };
});

const PM = "ag_pm";
const DESIGNER = "ag_designer";
const CHAT = "oc_loop";

function inbound(overrides: Partial<ChannelInboundMessage> = {}): ChannelInboundMessage {
  return {
    channel: "feishu",
    agentId: PM,
    chatId: CHAT,
    chatType: "group",
    messageId: "om_1",
    senderId: "ou_someone",
    senderType: "user",
    senderIsBot: false,
    mentionedBot: true,
    mentionOpenIds: [],
    content: "开始吧",
    threadId: null,
    createTime: 1,
    ...overrides
  };
}

describe("a group where two bots mention each other", () => {
  let teardown: () => void;

  beforeEach(() => {
    teardown = setupTestDatabase("agentmeld-channel-loop-");
    sent.length = 0;
    channelsByAgent.clear();
    startAgentRunMock.mockReset();
    startAgentRunMock.mockImplementation((input: { agentId: string }) => ({
      runId: `run_${input.agentId}`,
      abort: () => {}
    }));
    stopChannelRouterForTests();
    stopChannelProjectionForTests();
    setChannelProjectionPaused(false);

    for (const [agentId, appId] of [
      [PM, "cli_pm"],
      [DESIGNER, "cli_designer"]
    ] as const) {
      upsertChannelBinding({
        id: `cb_${agentId}`,
        agentId,
        channel: "feishu",
        appId,
        appSecret: "s",
        now: 1
      });
      channelsByAgent.set(agentId, { send: async () => ({ messageId: "om" }) });
    }
    setChannelBindingBotOpenId(`cb_${PM}`, "ou_bot_pm");
    setChannelBindingBotOpenId(`cb_${DESIGNER}`, "ou_bot_designer");
  });

  afterEach(() => {
    stopChannelRouterForTests();
    stopChannelProjectionForTests();
    teardown();
  });

  it("answers a person, then stops — and a bot's mention of the other bot starts nothing", async () => {
    startChannelRouter();
    startChannelProjection();

    // 1. A person @s one agent. This is the only thing that may start work.
    await eventBus.publish({
      type: "channel.inbound",
      conversationId: "",
      timestamp: 1,
      message: inbound({ messageId: "om_human", mentionOpenIds: ["ou_bot_pm"] })
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(startAgentRunMock).toHaveBeenCalledTimes(1);

    const conversationId = getChannelConversationByChat("feishu", CHAT)!.conversationId;

    // 2. That agent's answer is posted to the group.
    const answer = createConversationAndMessage(conversationId);
    eventBus.publish({
      type: "message.end",
      conversationId,
      timestamp: 2,
      messageId: answer,
      status: "complete"
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(sent).toHaveLength(1);

    // 3. Another bot @s the second agent — the shape a bot-at-bot hop would
    //    take in this group. It arrives, and it must start nothing.
    await eventBus.publish({
      type: "channel.inbound",
      conversationId: "",
      timestamp: 3,
      message: inbound({
        messageId: "om_bot",
        agentId: DESIGNER,
        senderId: "ou_bot_pm",
        senderType: "bot",
        senderIsBot: true,
        mentionOpenIds: ["ou_bot_pm", "ou_bot_designer"],
        content: "@设计 你来做"
      })
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    // The message is recorded — the conversation should show what was said —
    // but no run follows, so nothing new can be produced and nothing new can be
    // posted. This is the loop breaking, not being noticed.
    expect(startAgentRunMock).toHaveBeenCalledTimes(1);
    expect(listMessages(conversationId).some((m) => m.origin === "bot")).toBe(true);

    // 4. Give any hypothetical cycle several chances to be visible, then assert
    //    the totals are unchanged: bounded, and stopped.
    for (let i = 0; i < 5; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(startAgentRunMock).toHaveBeenCalledTimes(1);
    expect(sent).toHaveLength(1);
  });

  it("starts nothing when the sender cannot be identified", async () => {
    // The other half of the origin decision, and the half the acceptance test
    // was missing: an unknown sender kind must fall to `internal`, which cannot
    // dispatch. Reading it as `human` is a real breach — the mutation
    // `return "internal"` -> `return "human"` left this suite green before.
    startChannelRouter();
    startChannelProjection();

    await eventBus.publish({
      type: "channel.inbound",
      conversationId: "",
      timestamp: 1,
      message: inbound({
        messageId: "om_unknown",
        senderId: "ou_who_knows",
        senderType: null,
        senderIsBot: null,
        mentionOpenIds: ["ou_bot_pm"],
        content: "我是谁"
      })
    });
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(startAgentRunMock).not.toHaveBeenCalled();
    expect(sent).toHaveLength(0);
  });

  it("does not echo a person's own message back into the group", async () => {
    // Pins the OUTCOME: a person's message is not echoed into the room.
    //
    // It does not pin which guard produces it. Two independent conditions stop
    // a person's message — `role !== "agent"` and a null `agentId` — and
    // removing either alone changes nothing observable, so no test can catch
    // one of them being deleted. That is safe (the behaviour survives) but it
    // does mean neither guard is individually load-bearing, and a future change
    // should not assume a test protects it.
    //
    // The consequence is worth stating rather than hiding: a message typed in
    // the web UI of a channel conversation is NOT posted to the group, so the
    // two views differ for that one case. Messages that came from Feishu are
    // already in the room, and posting those back would be an echo.
    startChannelRouter();
    startChannelProjection();

    await eventBus.publish({
      type: "channel.inbound",
      conversationId: "",
      timestamp: 1,
      message: inbound({ messageId: "om_human", mentionOpenIds: ["ou_bot_pm"] })
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const conversationId = getChannelConversationByChat("feishu", CHAT)!.conversationId;

    const human = createMessage({
      id: "msg_human",
      conversationId,
      role: "user",
      agentId: null,
      parts: [{ type: "text", content: "我在网页里打的这句" }],
      status: "complete",
      now: 2
    });
    eventBus.publish({
      type: "message.end",
      conversationId,
      timestamp: 2,
      messageId: human.id,
      status: "complete"
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(sent).toHaveLength(0);
  });

  it("stops too when the group's message comes only from bots", async () => {
    // The pure bot-at-bot case, with no person involved at all.
    startChannelRouter();
    startChannelProjection();

    await eventBus.publish({
      type: "channel.inbound",
      conversationId: "",
      timestamp: 1,
      message: inbound({
        messageId: "om_bot_only",
        agentId: DESIGNER,
        senderId: "ou_bot_pm",
        senderType: "bot",
        senderIsBot: true,
        mentionOpenIds: ["ou_bot_pm", "ou_bot_designer"],
        content: "接力给你"
      })
    });
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(startAgentRunMock).not.toHaveBeenCalled();
    expect(sent).toHaveLength(0);
  });

  it("posts one message per answer, however many times the end is seen", async () => {
    startChannelRouter();
    startChannelProjection();

    await eventBus.publish({
      type: "channel.inbound",
      conversationId: "",
      timestamp: 1,
      message: inbound({ messageId: "om_human", mentionOpenIds: ["ou_bot_pm"] })
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const conversationId = getChannelConversationByChat("feishu", CHAT)!.conversationId;
    const answer = createConversationAndMessage(conversationId);

    for (let i = 0; i < 3; i += 1) {
      eventBus.publish({
        type: "message.end",
        conversationId,
        timestamp: 2 + i,
        messageId: answer,
        status: "complete"
      });
    }
    await new Promise((resolve) => setTimeout(resolve, 30));

    // One post per message, not one per event. The earlier assertion here was
    // `toBeLessThanOrEqual(3)`, which zero also satisfies — it could not have
    // failed for the reason its name claimed.
    expect(sent).toHaveLength(1);
    expect(sent[0].chatId).toBe(CHAT);
  });
});

/** Insert an agent message the way the runner does, and return its id. */
function createConversationAndMessage(conversationId: string): string {
  const message = createMessage({
    id: `msg_${Math.random().toString(36).slice(2, 8)}`,
    conversationId,
    role: "agent",
    agentId: PM,
    parts: [{ type: "text", content: "答案是 42" }],
    status: "complete",
    now: 2
  });
  return message.id;
}
