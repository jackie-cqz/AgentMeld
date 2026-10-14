import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setupTestDatabase } from "@/test/test-database";
import {
  originForSender,
  routeChannelInbound,
  startChannelRouter,
  stopChannelRouterForTests
} from "@/server/channels/feishu/router";
import { eventBus } from "@/server/event-bus";
import {
  getChannelConversationByChat,
  getChannelInboundMessage,
  listChannelConversationMembers,
  listMessages,
  setChannelBindingBotOpenId,
  upsertChannelBinding
} from "@/server/repositories";
import type { ChannelInboundMessage } from "@/shared/types";

/**
 * `startAgentRun` is stubbed: what matters here is WHO was asked to answer, not
 * what an agent then does. A real run would reach for a model.
 */
const { startAgentRunMock } = vi.hoisted(() => ({ startAgentRunMock: vi.fn() }));

vi.mock("@/server/channels/feishu/attachment-import", () => ({
  // One file fails, so the notice is produced.
  importInboundResources: async () => ({
    status: "imported",
    attachmentIds: [],
    skipped: ["坏的.pdf（下载失败）"]
  }),
  describeSkippedResources: (skipped: string[]) =>
    skipped.length ? `⚠️ 有附件没能导入：${skipped.join("、")}` : null
}));

vi.mock("@/server/agent-runner", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/agent-runner")>();
  return {
    ...actual,
    startAgentRun: (...args: unknown[]) => startAgentRunMock(...args)
  };
});

function inbound(overrides: Partial<ChannelInboundMessage> = {}): ChannelInboundMessage {
  return {
    channel: "feishu",
    agentId: "ag_pm",
    chatId: "oc_1",
    chatType: "group",
    messageId: "om_1",
    senderId: "ou_human",
    senderType: "user",
    senderIsBot: false,
    mentionedBot: true,
    mentionOpenIds: [],
    resources: [],
    content: "帮我看看这个",
    threadId: null,
    createTime: 1,
    ...overrides
  };
}

describe("originForSender", () => {
  it("treats a person as a person", () => {
    expect(originForSender("user", false)).toBe("human");
  });

  it("treats another bot as a bot", () => {
    expect(originForSender("bot", true)).toBe("bot");
  });

  it("never guesses 'human' for an unidentifiable sender", () => {
    // The safe direction: `internal` cannot start a run, so an event whose
    // sender we could not name is recorded without being acted on rather than
    // being handed a person's permissions.
    expect(originForSender(null, null)).toBe("internal");
    expect(originForSender("anonymous", null)).toBe("internal");
    expect(originForSender("system", null)).toBe("internal");
  });

  it("lets the derived bot flag confirm an unfamiliar sender kind", () => {
    expect(originForSender("app", true)).toBe("bot");
  });
});

describe("routeChannelInbound", () => {
  let teardown: () => void;

  beforeEach(() => {
    teardown = setupTestDatabase("agentmeld-channel-router-");
    startAgentRunMock.mockReset();
    startAgentRunMock.mockImplementation((input: { agentId: string }) => ({
      runId: `run_${input.agentId}`,
      abort: () => {}
    }));
  });

  afterEach(() => {
    stopChannelRouterForTests();
    teardown();
  });

  it("creates and links a conversation the first time a chat speaks", async () => {
    const outcome = await routeChannelInbound(inbound());

    expect(outcome.status).toBe("routed");
    if (outcome.status !== "routed") return;
    expect(getChannelConversationByChat("feishu", "oc_1")?.conversationId).toBe(
      outcome.conversationId
    );
  });

  it("stores the message in the conversation's own history", async () => {
    const outcome = await routeChannelInbound(inbound());
    if (outcome.status !== "routed") throw new Error("expected routed");

    const messages = listMessages(outcome.conversationId);
    expect(messages.some((message) => message.id === outcome.messageId)).toBe(true);
  });

  it("lets a human message start a run", async () => {
    const outcome = await routeChannelInbound(inbound());

    expect(outcome.status).toBe("routed");
    if (outcome.status !== "routed") return;
    expect(outcome.origin).toBe("human");
    expect(outcome.runIds.length).toBeGreaterThan(0);
  });

  it("records a bot message without letting it start anything", async () => {
    // §5.8 layer 3. This is the gate that stops two bots from answering each
    // other forever: a message from a bot is history, never a request.
    const outcome = await routeChannelInbound(
      inbound({ senderId: "ou_other_bot", senderType: "bot", senderIsBot: true })
    );

    expect(outcome.status).toBe("routed");
    if (outcome.status !== "routed") return;
    expect(outcome.origin).toBe("bot");
    expect(outcome.runIds).toEqual([]);
    // It is still recorded: the conversation should show what was said.
    const messages = listMessages(outcome.conversationId);
    expect(messages.some((message) => message.id === outcome.messageId)).toBe(true);
  });

  it("treats a redelivery as a duplicate and does not store it twice", async () => {
    const first = await routeChannelInbound(inbound());
    const second = await routeChannelInbound(inbound());

    expect(first.status).toBe("routed");
    expect(second.status).toBe("duplicate");
    if (first.status !== "routed") return;
    // What the test is about: the HUMAN message is stored once. Counting every
    // row was too broad — a routing notice is also a message, and it is not
    // what "redelivery" concerns.
    const fromSender = listMessages(first.conversationId).filter((m) => m.role === "user");
    expect(fromSender).toHaveLength(1);
    // And the inbound content is not the notice's.
    const body = fromSender[0].parts.find((p) => p.type === "text");
    expect(body?.type === "text" && body.content).toContain("帮我看看这个");
  });

  it("marks a claimed message even when routing it produced no run", async () => {
    await routeChannelInbound(inbound({ senderType: "bot", senderIsBot: true }));
    const again = await routeChannelInbound(inbound({ senderType: "bot", senderIsBot: true }));

    expect(again.status).toBe("duplicate");
  });

  it("records an empty mention without inventing work for an agent", async () => {
    const outcome = await routeChannelInbound(inbound({ content: "   " }));

    expect(outcome.status).toBe("ignored");
    expect(startAgentRunMock).not.toHaveBeenCalled();
    // Recorded as seen, so a redelivery is not mistaken for new.
    expect(getChannelInboundMessage("feishu", "om_1")).not.toBeNull();
  });

  it("does not start work for a sender it could not identify", async () => {
    const outcome = await routeChannelInbound(inbound({ senderType: null, senderIsBot: null }));

    expect(outcome.status).toBe("routed");
    if (outcome.status !== "routed") return;
    expect(outcome.origin).toBe("internal");
    expect(outcome.runIds).toEqual([]);
  });

  it("keeps chats apart", async () => {
    const a = await routeChannelInbound(inbound({ chatId: "oc_a", messageId: "om_a" }));
    const b = await routeChannelInbound(inbound({ chatId: "oc_b", messageId: "om_b" }));

    if (a.status !== "routed" || b.status !== "routed") throw new Error("expected routed");
    expect(a.conversationId).not.toBe(b.conversationId);
  });

  describe("a message that mentions two bots", () => {
    beforeEach(() => {
      // Both agents are bound and connected, so both mentions can be resolved.
      upsertChannelBinding({
        id: "cb_pm",
        agentId: "ag_pm",
        channel: "feishu",
        appId: "cli_pm",
        appSecret: "s",
        now: 1
      });
      upsertChannelBinding({
        id: "cb_designer",
        agentId: "ag_designer",
        channel: "feishu",
        appId: "cli_designer",
        appSecret: "s",
        now: 1
      });
      setChannelBindingBotOpenId("cb_pm", "ou_bot_pm");
      setChannelBindingBotOpenId("cb_designer", "ou_bot_designer");
    });

    it("asks both, from the first delivery alone", async () => {
      // The platform delivers once per mentioned bot and the addressee list is
      // identical in each, so the first delivery that arrives can answer for
      // all of them. Without that, the second addressee's own delivery is
      // discarded as a duplicate and it is never asked.
      const outcome = await routeChannelInbound(
        inbound({
          agentId: "ag_pm",
          mentionOpenIds: ["ou_bot_pm", "ou_bot_designer"],
          resources: [],
          messageId: "om_two"
        })
      );

      if (outcome.status !== "routed") throw new Error("expected routed");
      const asked = startAgentRunMock.mock.calls.map(
        (call) => (call[0] as { agentId: string }).agentId
      );
      expect(asked.sort()).toEqual(["ag_designer", "ag_pm"]);
    });

    it("discards the other bot's own delivery without losing its membership", async () => {
      await routeChannelInbound(
        inbound({
          agentId: "ag_pm",
          mentionOpenIds: ["ou_bot_pm", "ou_bot_designer"],
          resources: [],
          messageId: "om_two"
        })
      );
      const second = await routeChannelInbound(
        inbound({
          agentId: "ag_designer",
          mentionOpenIds: ["ou_bot_pm", "ou_bot_designer"],
          resources: [],
          messageId: "om_two"
        })
      );

      expect(second.status).toBe("duplicate");
      const cc = getChannelConversationByChat("feishu", "oc_1");
      expect(listChannelConversationMembers(cc!.id).sort()).toEqual(["ag_designer", "ag_pm"]);
    });

    it("records a mentioned agent as present even before its own bot speaks", async () => {
      // Being mentioned proves the bot is in the room — only a member can be
      // mentioned — so this is the same evidence membership always uses.
      await routeChannelInbound(
        inbound({
          agentId: "ag_pm",
          mentionOpenIds: ["ou_bot_pm", "ou_bot_designer"],
          resources: [],
          messageId: "om_two"
        })
      );

      const cc = getChannelConversationByChat("feishu", "oc_1");
      expect(listChannelConversationMembers(cc!.id)).toContain("ag_designer");
    });

    it("ignores a mention it cannot map to one of our agents", async () => {
      const outcome = await routeChannelInbound(
        inbound({
          agentId: "ag_pm",
          mentionOpenIds: ["ou_bot_pm", "ou_some_stranger"],
          resources: [],
          messageId: "om_three"
        })
      );

      if (outcome.status !== "routed") throw new Error("expected routed");
      const asked = startAgentRunMock.mock.calls.map(
        (call) => (call[0] as { agentId: string }).agentId
      );
      expect(asked).toEqual(["ag_pm"]);
    });
  });
});

describe("startChannelRouter", () => {
  let teardown: () => void;

  beforeEach(() => {
    teardown = setupTestDatabase("agentmeld-channel-router-sub-");
    startAgentRunMock.mockReset();
    startAgentRunMock.mockImplementation((input: { agentId: string }) => ({
      runId: `run_${input.agentId}`,
      abort: () => {}
    }));
  });

  afterEach(() => {
    stopChannelRouterForTests();
    teardown();
  });

  it("returns the same subscription when started twice", () => {
    // The module is re-evaluated on hot reload, so this idempotence is the
    // guard. Asserting it directly is the only honest check: an earlier version
    // of this test counted dispatch calls after a second subscription, which
    // proves nothing — the per-message claim would dedupe the duplicate anyway,
    // so the count stays at one whether or not the guard works.
    const first = startChannelRouter();
    const second = startChannelRouter();
    expect(second).toBe(first);
  });

  it("routes a message once even when it is delivered twice", async () => {
    // What the previous test only appeared to show. This is the claim doing the
    // work, not the subscription guard.
    startChannelRouter();
    const event = {
      type: "channel.inbound" as const,
      conversationId: "",
      timestamp: 1,
      message: inbound()
    };
    eventBus.publish(event);
    eventBus.publish(event);
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(startAgentRunMock).toHaveBeenCalledTimes(1);
  });

  it("stops routing after the subscription is stopped", async () => {
    const stop = startChannelRouter();
    stop();

    eventBus.publish({
      type: "channel.inbound",
      conversationId: "",
      timestamp: 2,
      message: inbound({ messageId: "om_after_stop" })
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(startAgentRunMock).not.toHaveBeenCalled();
  });
});

describe("an attachment that does not arrive", () => {
  let teardown: () => void;

  beforeEach(() => {
    teardown = setupTestDatabase("agentmeld-router-notice-");
    startAgentRunMock.mockReset();
    startAgentRunMock.mockImplementation((input: { agentId: string }) => ({
      runId: `run_${input.agentId}`,
      abort: () => {}
    }));
  });

  afterEach(() => {
    stopChannelRouterForTests();
    teardown();
  });

  it("is recorded where the room can hear it", async () => {
    // The bug this pins, and the review that caught it: the notice was written
    // with `sendMessage`, which produces role "user" — and the projection sends
    // agent answers and SYSTEM notices. So it reached the web and never left
    // AgentMeld, while the commit claimed "the person who sent it is the one
    // who needs to know". They are in the room.
    const outcome = await routeChannelInbound(
      inbound({
        messageId: "om_attach",
        resources: [{ type: "file", fileKey: "fk", fileName: "坏的.pdf" }]
      })
    );
    expect(outcome.status).toBe("routed");
    if (outcome.status !== "routed") return;

    const notice = listMessages(outcome.conversationId).find((m) => m.role === "system");
    expect(notice).toBeDefined();
    // System AND named: a notice with no agent has no bot that could deliver it.
    expect(notice?.agentId).toBe("ag_pm");
    const body = notice?.parts.find((p) => p.type === "text");
    expect(body?.type === "text" && body.content).toContain("坏的.pdf");
  });
});
