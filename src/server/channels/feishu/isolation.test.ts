import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setupTestDatabase } from "@/test/test-database";
import { eventBus } from "@/server/event-bus";
import { startChannelProjection, stopChannelProjectionForTests, setChannelProjectionPaused } from "@/server/channels/feishu/projection";
import { startChannelInteractions, stopChannelInteractionsForTests } from "@/server/channels/feishu/interaction";
import { startChannelArtifactDelivery, stopChannelArtifactDeliveryForTests } from "@/server/channels/feishu/artifact-delivery";
import { startChannelProgress, stopChannelProgressForTests } from "@/server/channels/feishu/progress";
import {
  createChannelConversation,
  createConversation,
  createMessage,
  createRun,
  getChannelConversationByChat,
  listMessages,
  setChannelBindingBotOpenId,
  upsertChannelBinding
} from "@/server/repositories";
import type { Artifact } from "@/shared/types";

/**
 * Two groups, one set of agents.
 *
 * Every layer addresses something — a chat, a conversation, a run, a pending —
 * and each of those keys is the only thing keeping one room's traffic out of
 * another's. The routing layer has a test for this; nothing else did. These
 * tests run the real stack and assert that a group receives its own work and
 * nobody else's.
 *
 * The failure this guards against is quiet: a card or a file appearing in the
 * wrong room looks like the bot being confused, not like a bug, and no unit
 * test of any single module would see it.
 */
const { channelsByAgent, sent, updated } = vi.hoisted(() => ({
  channelsByAgent: new Map<string, unknown>(),
  sent: [] as Array<{ agentId: string; chatId: string; input: Record<string, unknown> }>,
  updated: [] as Array<{ messageId: string; card: unknown }>
}));

vi.mock("@/server/channels/feishu/registry", () => ({
  getFeishuChannelForAgent: (agentId: string) => {
    if (!channelsByAgent.has(agentId)) return null;
    return {
      send: async (chatId: string, input: Record<string, unknown>) => {
        sent.push({ agentId, chatId, input });
        return { messageId: `om_${sent.length}` };
      },
      updateCard: async (messageId: string, card: unknown) => {
        updated.push({ messageId, card });
      }
    };
  },
  listFeishuConnections: () => [{ agentId: AGENT, botName: "PM 小灰" }]
}));

vi.mock("@/server/agent-runner", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/agent-runner")>();
  return {
    ...actual,
    startAgentRun: (input: { agentId: string }) => ({ runId: `run_${input.agentId}`, abort: () => {} })
  };
});

const AGENT = "ag_pm";
const CHAT_A = "oc_group_a";
const CHAT_B = "oc_group_b";

/** Where each chat's traffic should go, resolved the way the router resolves it. */
function conversationFor(chatId: string): string {
  const mapping = getChannelConversationByChat("feishu", chatId);
  if (!mapping) throw new Error(`no conversation for ${chatId}`);
  return mapping.conversationId;
}

/** Everything that went to a given chat, and nothing that went anywhere else. */
function sentTo(chatId: string, kind: "text" | "card" | "file") {
  return sent.filter((entry) => entry.chatId === chatId && kind in entry.input);
}

describe("two groups sharing one set of agents", () => {
  let teardown: () => void;

  beforeEach(() => {
    teardown = setupTestDatabase("agentmeld-channel-isolation-");
    sent.length = 0;
    updated.length = 0;
    channelsByAgent.clear();
    stopChannelProjectionForTests();
    stopChannelInteractionsForTests();
    stopChannelArtifactDeliveryForTests();
    stopChannelProgressForTests();
    setChannelProjectionPaused(false);

    upsertChannelBinding({
      id: "cb_pm", agentId: AGENT, channel: "feishu", appId: "cli_pm", appSecret: "s",
      boundByOpenId: "ou_user", now: 1
    });
    setChannelBindingBotOpenId("cb_pm", "ou_bot_pm");
    channelsByAgent.set(AGENT, {});

    for (const chatId of [CHAT_A, CHAT_B]) {
      const conversationId = `conv_${chatId.slice(-1)}`;
      createConversation({
        id: conversationId, title: chatId, mode: "group", agentIds: [AGENT],
        fsWriteApprovalMode: "auto", now: 1
      });
      createChannelConversation({
        id: `cc_${chatId.slice(-1)}`, channel: "feishu", chatId, conversationId, now: 1
      });
    }
  });

  afterEach(() => {
    stopChannelProjectionForTests();
    stopChannelInteractionsForTests();
    stopChannelArtifactDeliveryForTests();
    stopChannelProgressForTests();
    teardown();
  });

  it("keeps one room's messages out of the other", async () => {
    const { sendMessage } = await import("@/server/conversation-service");
    const conversationA = conversationFor(CHAT_A);
    const conversationB = conversationFor(CHAT_B);
    startChannelProjection();

    const message = createMessage({
      id: "msg_a", conversationId: conversationA, role: "agent", agentId: AGENT,
      parts: [{ type: "text", content: "这是 A 群的答复" }], status: "complete", now: 2
    });
    eventBus.publish({
      type: "message.end", conversationId: conversationA, timestamp: 2,
      messageId: message.id, status: "complete"
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(sentTo(CHAT_A, "text")).toHaveLength(1);
    expect(sentTo(CHAT_B, "text")).toHaveLength(0);
    // And it really landed in A's history, not B's.
    expect(listMessages(conversationA).some((row) => row.id === message.id)).toBe(true);
    expect(listMessages(conversationB)).toHaveLength(0);
    void sendMessage;
  });

  it("sends two concurrent runs' progress cards to their own rooms", async () => {
    startChannelProgress();

    const runA = createRun({
      id: "run_a", conversationId: conversationFor(CHAT_A), agentId: AGENT,
      triggerMessageId: null, parentRunId: null, status: "running", now: 1
    });
    const runB = createRun({
      id: "run_b", conversationId: conversationFor(CHAT_B), agentId: AGENT,
      triggerMessageId: null, parentRunId: null, status: "running", now: 1
    });

    for (const run of [runA, runB]) {
      eventBus.publish({
        type: "run.start", conversationId: run.conversationId, timestamp: 2,
        runId: run.id, agentId: AGENT, triggerMessageId: null
      });
    }
    await new Promise((resolve) => setTimeout(resolve, 30));

    // One card each, in the right room — concurrency must not cross them.
    expect(sentTo(CHAT_A, "card")).toHaveLength(1);
    expect(sentTo(CHAT_B, "card")).toHaveLength(1);

    // Ending one settles only its own card.
    updated.length = 0;
    eventBus.publish({
      type: "run.end", conversationId: runA.conversationId, timestamp: 3,
      runId: runA.id, status: "complete"
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(updated).toHaveLength(1);
  });

  it("delivers an artifact only to the room it belongs to", async () => {
    startChannelArtifactDelivery();
    const conversationA = conversationFor(CHAT_A);

    const artifact: Artifact = {
      id: "art_a", conversationId: conversationA, createdByAgentId: AGENT,
      type: "document", title: "A 群的产物",
      content: { type: "document", content: "# A" },
      version: 1, parentArtifactId: null, createdAt: 1, updatedAt: 1
    };

    eventBus.publish({ type: "artifact.create", conversationId: conversationA, timestamp: 1, artifact });
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(sentTo(CHAT_A, "file")).toHaveLength(1);
    expect(sentTo(CHAT_B, "file")).toHaveLength(0);
  });

  it("asks a question in one room and answers it there", async () => {
    startChannelInteractions();
    const conversationA = conversationFor(CHAT_A);
    const conversationB = conversationFor(CHAT_B);

    const { registerPendingQuestion, clearPendingQuestionsForTests } = await import(
      "@/server/pending-questions"
    );
    clearPendingQuestionsForTests();
    const pending = registerPendingQuestion(conversationA, AGENT, "run_a", [
      { question: "继续吗？", header: "确认", options: [{ label: "是" }] }
    ]);
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(sentTo(CHAT_A, "card")).toHaveLength(1);
    expect(sentTo(CHAT_B, "card")).toHaveLength(0);

    // Answering from the other room is refused, and the run keeps waiting.
    const { handleCardAction } = await import("@/server/channels/feishu/interaction");
    const pendingId = [...((globalThis as unknown as { __agentMeldPendingQuestions: Map<string, unknown> })
      .__agentMeldPendingQuestions.keys())][0] as string;

    const refused = await handleCardAction({
      messageId: "om_card", chatId: CHAT_B, operator: { openId: "ou_user", name: "张三" },
      action: { value: { kind: "ask_user", pendingId, questionIndex: 0, answer: "是" }, tag: "button" }
    } as never);
    expect(refused).toMatchObject({ toast: { type: "error" } });

    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(settled).toBe(false);

    // In the right room it resolves.
    const accepted = await handleCardAction({
      messageId: "om_card", chatId: CHAT_A, operator: { openId: "ou_user", name: "张三" },
      action: { value: { kind: "ask_user", pendingId, questionIndex: 0, answer: "是" }, tag: "button" }
    } as never);
    expect(accepted).toMatchObject({ toast: { type: "success" } });
    await expect(pending).resolves.toEqual({ "继续吗？": "是" });
    expect(conversationA).not.toBe(conversationB);
  });
});
