import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setupTestDatabase } from "@/test/test-database";
import {
  buildQuestionCard,
  decodeCardActionValue,
  handleCardAction,
  projectPendingQuestion,
  startChannelInteractions,
  stopChannelInteractionsForTests
} from "@/server/channels/feishu/interaction";
import { registerPendingQuestion, clearPendingQuestionsForTests } from "@/server/pending-questions";
import { createChannelConversation, createConversation } from "@/server/repositories";
import type { CardActionEvent } from "@larksuite/channel";
import type { PendingQuestion } from "@/shared/types";

const { channelsByAgent, sent } = vi.hoisted(() => ({
  channelsByAgent: new Map<string, unknown>(),
  sent: [] as Array<{ agentId: string; chatId: string; input: unknown }>
}));

vi.mock("@/server/channels/feishu/connection", () => ({
  getFeishuChannelForAgent: (agentId: string) => {
    const channel = channelsByAgent.get(agentId);
    if (!channel) return null;
    return {
      send: async (chatId: string, input: unknown) => {
        sent.push({ agentId, chatId, input });
        return { messageId: `om_${sent.length}` };
      }
    };
  }
}));

const AGENT = "ag_pm";

function click(value: unknown, operator = { openId: "ou_user", name: "张三" }): CardActionEvent {
  return {
    messageId: "om_card",
    chatId: "oc_1",
    operator,
    action: { value, tag: "button" }
  } as CardActionEvent;
}

describe("decodeCardActionValue", () => {
  it("accepts a well-formed button value", () => {
    expect(
      decodeCardActionValue({ kind: "ask_user", pendingId: "pq_1", questionIndex: 0, answer: "Vue" })
    ).toEqual({ kind: "ask_user", pendingId: "pq_1", questionIndex: 0, answer: "Vue" });
  });

  it("refuses anything it does not own", () => {
    // A card value is untrusted input: it comes back from the platform and could
    // be anything, including something another bot's card carried.
    expect(decodeCardActionValue(null)).toBeNull();
    expect(decodeCardActionValue("pq_1")).toBeNull();
    expect(decodeCardActionValue({ kind: "other" })).toBeNull();
    expect(decodeCardActionValue({ kind: "ask_user", pendingId: "", questionIndex: 0, answer: "x" })).toBeNull();
    expect(decodeCardActionValue({ kind: "ask_user", pendingId: "pq_1", questionIndex: 1.5, answer: "x" })).toBeNull();
    expect(decodeCardActionValue({ kind: "ask_user", pendingId: "pq_1", questionIndex: 0, answer: 42 })).toBeNull();
  });
});

describe("buildQuestionCard", () => {
  const question: PendingQuestion = {
    id: "pq_1",
    conversationId: "conv_1",
    agentId: AGENT,
    runId: "run_1",
    createdAt: 1,
    questions: [
      { question: "用哪个框架？", header: "技术栈", options: [{ label: "Vue" }, { label: "React" }] }
    ]
  };

  it("offers every option as a button that carries what it means", () => {
    const card = buildQuestionCard(question) as { elements: Array<Record<string, unknown>> };
    const action = card.elements.find((element) => element.tag === "action") as {
      actions: Array<{ text: { content: string }; value: unknown }>;
    };

    expect(action.actions.map((button) => button.text.content)).toEqual(["Vue", "React"]);
    expect(action.actions[0].value).toEqual({
      kind: "ask_user",
      pendingId: "pq_1",
      questionIndex: 0,
      answer: "Vue"
    });
  });

  it("shows the question and its header", () => {
    const raw = JSON.stringify(buildQuestionCard(question));
    expect(raw).toContain("技术栈");
    expect(raw).toContain("用哪个框架？");
  });

  it("marks an answered question and makes its buttons inert", () => {
    // The card stays a readable record of what was asked, rather than turning
    // into a bare label — but a second click must not be able to change it.
    const card = buildQuestionCard(question, { answered: { "用哪个框架？": "Vue" } }) as {
      elements: Array<Record<string, unknown>>;
    };
    const action = card.elements.find((element) => element.tag === "action") as {
      actions: Array<{ type: string; value?: unknown }>;
    };

    expect(action.actions[0].type).toBe("primary");
    expect(action.actions[0].value).toBeUndefined();
    expect(action.actions[1].value).toBeUndefined();
    expect(JSON.stringify(card)).toContain("已选择");
  });
});

describe("handleCardAction", () => {
  let teardown: () => void;

  beforeEach(() => {
    teardown = setupTestDatabase("agentmeld-channel-interaction-");
    sent.length = 0;
    channelsByAgent.clear();
    stopChannelInteractionsForTests();
    clearPendingQuestionsForTests();
    channelsByAgent.set(AGENT, {});
  });

  afterEach(() => {
    stopChannelInteractionsForTests();
    clearPendingQuestionsForTests();
    teardown();
  });

  function ask(options: { twoQuestions?: boolean } = {}) {
    const questions: PendingQuestion["questions"] = options.twoQuestions
      ? [
          { question: "用哪个框架？", header: "技术栈", options: [{ label: "Vue" }, { label: "React" }] },
          { question: "部署到哪？", header: "环境", options: [{ label: "预览" }, { label: "线上" }] }
        ]
      : [{ question: "用哪个框架？", header: "技术栈", options: [{ label: "Vue" }] }];

    const pending = registerPendingQuestion("conv_1", AGENT, "run_1", questions);
    // The id is generated inside; the store's newest key is it.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const store = (globalThis as any).__agentMeldPendingQuestions as Map<string, unknown>;
    const pendingId = [...store.keys()][store.size - 1] as string;
    return { pending, pendingId };
  }

  it("resolves a single-question pending and names the operator", async () => {
    const { pending, pendingId } = ask();

    const response = await handleCardAction(
      click({ kind: "ask_user", pendingId, questionIndex: 0, answer: "Vue" })
    );

    await expect(pending).resolves.toEqual({ "用哪个框架？": "Vue" });
    expect(response).toMatchObject({ toast: { type: "success" } });
  });

  it("does not resolve a multi-question pending until every answer is in", async () => {
    // `answerQuestion` resolves with whatever it is handed and deletes the
    // record, so sending one answer out of two would silently discard the other.
    const { pending, pendingId } = ask({ twoQuestions: true });
    let settled = false;
    void pending.then(() => {
      settled = true;
    });

    const partial = await handleCardAction(
      click({ kind: "ask_user", pendingId, questionIndex: 0, answer: "Vue" })
    );
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(partial).toMatchObject({ card: { type: "raw" } });
    expect(partial).not.toHaveProperty("toast");
    expect(settled).toBe(false);

    const complete = await handleCardAction(
      click({ kind: "ask_user", pendingId, questionIndex: 1, answer: "预览" })
    );
    expect(complete).toMatchObject({ toast: { type: "success" } });
    await expect(pending).resolves.toEqual({ "用哪个框架？": "Vue", "部署到哪？": "预览" });
  });

  it("says so, rather than failing silently, when the question is already gone", async () => {
    // A card left in the room after the run moved on: the click must land as a
    // visible message, not as nothing happening.
    const response = await handleCardAction(
      click({ kind: "ask_user", pendingId: "pq_missing", questionIndex: 0, answer: "Vue" })
    );

    expect(response).toMatchObject({ toast: { type: "info" } });
  });

  it("ignores a click it cannot attribute to one of its own cards", async () => {
    expect(await handleCardAction(click({ kind: "something_else" }))).toBeUndefined();
    expect(await handleCardAction(click(null))).toBeUndefined();
  });
});

describe("projectPendingQuestion", () => {
  let teardown: () => void;

  beforeEach(() => {
    teardown = setupTestDatabase("agentmeld-channel-interaction-post-");
    sent.length = 0;
    channelsByAgent.clear();
    stopChannelInteractionsForTests();

    createConversation({
      id: "conv_1",
      title: "飞书群",
      mode: "group",
      agentIds: [AGENT],
      fsWriteApprovalMode: "auto",
      now: 1
    });
    channelsByAgent.set(AGENT, {});
  });

  afterEach(() => {
    stopChannelInteractionsForTests();
    teardown();
  });

  const question: PendingQuestion = {
    id: "pq_1",
    conversationId: "conv_1",
    agentId: AGENT,
    runId: "run_1",
    createdAt: 1,
    questions: [{ question: "继续吗？", header: "确认", options: [{ label: "是" }] }]
  };

  it("posts the card into the chat the conversation speaks to", async () => {
    createChannelConversation({
      id: "cc_1",
      channel: "feishu",
      chatId: "oc_1",
      conversationId: "conv_1",
      now: 1
    });

    const outcome = await projectPendingQuestion(question);

    expect(outcome.status).toBe("posted");
    expect(sent).toHaveLength(1);
    expect(sent[0].agentId).toBe(AGENT);
    expect(sent[0].chatId).toBe("oc_1");
    expect(sent[0].input).toHaveProperty("card");
  });

  it("stays silent for a conversation that is not on a channel", async () => {
    const outcome = await projectPendingQuestion(question);

    expect(outcome).toEqual({ status: "skipped", reason: "conversation is not on a channel" });
    expect(sent).toHaveLength(0);
  });

  it("stays silent rather than asking as the wrong agent", async () => {
    createChannelConversation({
      id: "cc_1",
      channel: "feishu",
      chatId: "oc_1",
      conversationId: "conv_1",
      now: 1
    });
    channelsByAgent.clear();

    const outcome = await projectPendingQuestion(question);

    expect(outcome).toEqual({ status: "skipped", reason: "agent has no live channel" });
    expect(sent).toHaveLength(0);
  });

  it("posts once when started twice", () => {
    const first = startChannelInteractions();
    const second = startChannelInteractions();
    expect(second).toBe(first);
  });

  it("posts when a question is asked", async () => {
    createChannelConversation({
      id: "cc_1",
      channel: "feishu",
      chatId: "oc_1",
      conversationId: "conv_1",
      now: 1
    });
    startChannelInteractions();

    const pending = registerPendingQuestion("conv_1", AGENT, "run_1", [
      { question: "继续吗？", header: "确认", options: [{ label: "是" }] }
    ]);
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(sent).toHaveLength(1);

    // Answer it so the promise settles and nothing is left hanging.
    const id = [...((globalThis as unknown as { __agentMeldPendingQuestions: Map<string, unknown> })
      .__agentMeldPendingQuestions.keys())][0];
    await handleCardAction(click({ kind: "ask_user", pendingId: id, questionIndex: 0, answer: "是" }));
    await expect(pending).resolves.toEqual({ "继续吗？": "是" });
  });
});
