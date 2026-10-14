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
    expect(listMessages(first.conversationId)).toHaveLength(1);
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
          messageId: "om_two"
        })
      );
      const second = await routeChannelInbound(
        inbound({
          agentId: "ag_designer",
          mentionOpenIds: ["ou_bot_pm", "ou_bot_designer"],
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

  it("subscribes only once, so a message is not routed twice", async () => {
    // The module is re-evaluated on hot reload; a second subscription would
    // route every message again, and the claim would turn the duplicate into a
    // silent drop rather than a visible error.
    const first = startChannelRouter();
    const second = startChannelRouter();
    expect(second).toBe(first);

    eventBus.publish({
      type: "channel.inbound",
      conversationId: "",
      timestamp: 1,
      message: inbound()
    });
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
