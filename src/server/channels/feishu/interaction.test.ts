import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setupTestDatabase } from "@/test/test-database";
import { getDatabase } from "@/db/client";
import { eventBus } from "@/server/event-bus";
import {
  buildApprovalCard,
  buildQuestionCard,
  decodeCardActionValue,
  handleCardAction,
  isAuthorisedOperator,
  projectPendingApproval,
  projectPendingQuestion,
  startChannelInteractions,
  stopChannelInteractionsForTests
} from "@/server/channels/feishu/interaction";
import { registerPendingQuestion, clearPendingQuestionsForTests } from "@/server/pending-questions";
import { registerPendingBash, clearPendingBashForTests } from "@/server/pending-bash";
import {
  createChannelConversation,
  createConversation,
  upsertChannelBinding
} from "@/server/repositories";
import type { CardActionEvent } from "@larksuite/channel";
import type { PendingBashCommand, PendingDispatchPlan, PendingQuestion } from "@/shared/types";

const { channelsByAgent, sent, updated } = vi.hoisted(() => ({
  channelsByAgent: new Map<string, unknown>(),
  sent: [] as Array<{ agentId: string; chatId: string; input: unknown }>,
  updated: [] as Array<{ messageId: string; card: unknown }>
}));

vi.mock("@/server/channels/feishu/connection", () => ({
  getFeishuChannelForAgent: (agentId: string) => {
    const channel = channelsByAgent.get(agentId);
    if (!channel) return null;
    return {
      send: async (chatId: string, input: unknown) => {
        sent.push({ agentId, chatId, input });
        return { messageId: `om_${sent.length}` };
      },
      updateCard: async (messageId: string, card: unknown) => {
        updated.push({ messageId, card });
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

describe("isAuthorisedOperator", () => {
  let teardown: () => void;

  beforeEach(() => {
    teardown = setupTestDatabase("agentmeld-channel-authorised-");
  });

  afterEach(() => {
    teardown();
  });

  it("allows the account that bound the app", () => {
    upsertChannelBinding({
      id: "cb_pm", agentId: AGENT, channel: "feishu", appId: "cli_pm", appSecret: "s",
      boundByOpenId: "ou_owner", now: 1
    });
    expect(isAuthorisedOperator(AGENT, "ou_owner")).toBe(true);
  });

  it("refuses anyone else", () => {
    upsertChannelBinding({
      id: "cb_pm", agentId: AGENT, channel: "feishu", appId: "cli_pm", appSecret: "s",
      boundByOpenId: "ou_owner", now: 1
    });
    expect(isAuthorisedOperator(AGENT, "ou_other")).toBe(false);
    expect(isAuthorisedOperator(AGENT, undefined)).toBe(false);
  });

  it("fails closed when the owner is not recorded", () => {
    // Not knowing who owns the app is not a reason to accept everyone.
    upsertChannelBinding({
      id: "cb_pm", agentId: AGENT, channel: "feishu", appId: "cli_pm", appSecret: "s",
      boundByOpenId: null, now: 1
    });
    expect(isAuthorisedOperator(AGENT, "ou_anyone")).toBe(false);
  });

  it("refuses an agent that is not bound at all", () => {
    expect(isAuthorisedOperator("ag_not_bound", "ou_owner")).toBe(false);
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
    updated.length = 0;
    channelsByAgent.clear();
    stopChannelInteractionsForTests();
    clearPendingQuestionsForTests();
    channelsByAgent.set(AGENT, {});

    // The single-owner model: answers are only taken from the account that
    // bound the app, which is the open id `click()` uses by default.
    upsertChannelBinding({
      id: "cb_pm",
      agentId: AGENT,
      channel: "feishu",
      appId: "cli_pm",
      appSecret: "s",
      boundByOpenId: "ou_user",
      now: 1
    });
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

  it("records the operator's identity, not their display name", async () => {
    // The review's sharpest point: the test named for this never asserted it,
    // and the code preferred `name` — which its owner chooses, and which this
    // codebase says in two other places is not identity. Read from the record
    // rather than the return value, because the record is what an audit reads.
    const { pending, pendingId } = ask();

    await handleCardAction(
      click({ kind: "ask_user", pendingId, questionIndex: 0, answer: "Vue" }, { openId: "ou_user", name: "任意昵称" })
    );

    const row = getDatabase()
      .prepare("SELECT resolved_by FROM pending_approvals WHERE id = ?")
      .get(pendingId) as { resolved_by: string | null } | undefined;
    expect(row?.resolved_by).toBe("ou_user");
    await expect(pending).resolves.toEqual({ "用哪个框架？": "Vue" });
  });

  it("refuses an answer the card never offered", async () => {
    // The card value comes back from the platform, so it can be forwarded or
    // crafted. Accepting any string would let arbitrary text into the run as
    // though the user had chosen it.
    const { pending, pendingId } = ask();

    const response = await handleCardAction(
      click({ kind: "ask_user", pendingId, questionIndex: 0, answer: "我编的" })
    );

    expect(response).toMatchObject({ toast: { type: "error" } });
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(settled).toBe(false);
  });

  it("refuses a click that arrived in a different chat", async () => {
    // A card can be forwarded, and its buttons would otherwise answer a question
    // in a room the clicker is not in.
    const { pending, pendingId } = ask();
    // The conversation row has to exist before a channel can point at it.
    createConversation({
      id: "conv_1", title: "飞书群", mode: "group", agentIds: [AGENT],
      fsWriteApprovalMode: "auto", now: 1
    });
    createChannelConversation({
      id: "cc_1", channel: "feishu", chatId: "oc_1", conversationId: "conv_1", now: 1
    });

    const event = click({ kind: "ask_user", pendingId, questionIndex: 0, answer: "Vue" });
    const response = await handleCardAction({ ...event, chatId: "oc_elsewhere" });

    expect(response).toMatchObject({ toast: { type: "error" } });
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(settled).toBe(false);
  });

  it("refuses an answer from someone other than the owner", async () => {
    // A group is exactly where people who are not the owner are present. Without
    // this, anyone who can see the card can answer a question the run is
    // waiting on.
    const { pending, pendingId } = ask();

    const response = await handleCardAction(
      click({ kind: "ask_user", pendingId, questionIndex: 0, answer: "Vue" }, { openId: "ou_stranger", name: "别人" })
    );

    expect(response).toMatchObject({ toast: { type: "error" } });
    // Still unanswered, and nothing buffered for it under the stranger.
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(settled).toBe(false);
  });

  it("refuses a click that carries no operator at all", async () => {
    const { pendingId } = ask();
    const response = await handleCardAction(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { messageId: "om", chatId: "oc_1", action: { value: { kind: "ask_user", pendingId, questionIndex: 0, answer: "Vue" }, tag: "button" } } as any
    );

    expect(response).toMatchObject({ toast: { type: "error" } });
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
    // Without this the store still holds the previous describe's pendings, and
    // "the newest key" is not the one this test just registered — the click goes
    // to a question from another test and the assertion fails for reasons that
    // have nothing to do with what it is testing.
    clearPendingQuestionsForTests();

    createConversation({
      id: "conv_1",
      title: "飞书群",
      mode: "group",
      agentIds: [AGENT],
      fsWriteApprovalMode: "auto",
      now: 1
    });
    channelsByAgent.set(AGENT, {});
    upsertChannelBinding({
      id: "cb_pm",
      agentId: AGENT,
      channel: "feishu",
      appId: "cli_pm",
      appSecret: "s",
      boundByOpenId: "ou_user",
      now: 1
    });
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

  it("settles the room's card when the question is answered elsewhere", async () => {
    // The web UI can answer first. Without this the group keeps a card whose
    // buttons look live and only say "already handled" once pressed.
    createChannelConversation({
      id: "cc_1", channel: "feishu", chatId: "oc_1", conversationId: "conv_1", now: 1
    });
    startChannelInteractions();
    updated.length = 0;

    const pending = registerPendingQuestion("conv_1", AGENT, "run_1", [
      { question: "继续吗？", header: "确认", options: [{ label: "是" }] }
    ]);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const id = [...((globalThis as unknown as { __agentMeldPendingQuestions: Map<string, unknown> })
      .__agentMeldPendingQuestions.keys())][0];

    eventBus.publish({
      type: "ask_user.answered",
      conversationId: "conv_1",
      timestamp: 2,
      pendingId: id,
      answers: { "继续吗？": "是" }
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(updated).toHaveLength(1);
    expect(JSON.stringify(updated[0].card)).toContain("已选择");

    // And the buffer that held partial answers is gone with it.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const buffer = (globalThis as any).__agentMeldChannelAnswers as Map<string, unknown>;
    expect(buffer.has(id)).toBe(false);

    // Settle the run's promise so nothing is left hanging.
    await handleCardAction(click({ kind: "ask_user", pendingId: id, questionIndex: 0, answer: "是" }));
    void pending;
  });

  it("settles the room's card when the question is cancelled", async () => {
    createChannelConversation({
      id: "cc_1", channel: "feishu", chatId: "oc_1", conversationId: "conv_1", now: 1
    });
    startChannelInteractions();
    updated.length = 0;

    registerPendingQuestion("conv_1", AGENT, "run_1", [
      { question: "继续吗？", header: "确认", options: [{ label: "是" }] }
    ]);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const id = [...((globalThis as unknown as { __agentMeldPendingQuestions: Map<string, unknown> })
      .__agentMeldPendingQuestions.keys())][0];

    eventBus.publish({
      type: "ask_user.cancelled",
      conversationId: "conv_1",
      timestamp: 2,
      pendingId: id,
      runId: "run_1"
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(updated).toHaveLength(1);
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

describe("approval cards", () => {
  let teardown: () => void;

  const bashItem: PendingBashCommand = {
    id: "pb_1",
    conversationId: "conv_1",
    agentId: AGENT,
    runId: "run_1",
    command: "rm -rf build",
    cwd: "/tmp/work",
    reason: "清理构建产物",
    createdAt: 1
  };

  const planItem: PendingDispatchPlan = {
    id: "pp_1",
    conversationId: "conv_1",
    runId: "run_1",
    createdAt: 1,
    plan: [
      { id: "t1", agentId: AGENT, task: "设计登录页", dependsOn: [], title: "登录页" }
    ]
  };

  beforeEach(() => {
    teardown = setupTestDatabase("agentmeld-channel-approval-");
    sent.length = 0;
    updated.length = 0;
    channelsByAgent.clear();
    stopChannelInteractionsForTests();
    clearPendingQuestionsForTests();
    clearPendingBashForTests();

    createConversation({
      id: "conv_1", title: "飞书群", mode: "group", agentIds: [AGENT],
      fsWriteApprovalMode: "auto", now: 1
    });
    createChannelConversation({
      id: "cc_1", channel: "feishu", chatId: "oc_1", conversationId: "conv_1", now: 1
    });
    channelsByAgent.set(AGENT, {});
    upsertChannelBinding({
      id: "cb_pm", agentId: AGENT, channel: "feishu", appId: "cli_pm", appSecret: "s",
      boundByOpenId: "ou_user", now: 1
    });
  });

  afterEach(() => {
    stopChannelInteractionsForTests();
    teardown();
  });

  it("decodes an approval value and refuses a malformed one", () => {
    expect(
      decodeCardActionValue({ kind: "approval", pendingType: "bash", pendingId: "pb_1", decision: "approve" })
    ).toEqual({ kind: "approval", pendingType: "bash", pendingId: "pb_1", decision: "approve" });

    expect(decodeCardActionValue({ kind: "approval", pendingType: "nope", pendingId: "pb_1", decision: "approve" })).toBeNull();
    expect(decodeCardActionValue({ kind: "approval", pendingType: "bash", pendingId: "pb_1", decision: "maybe" })).toBeNull();
  });

  it("shows what is being decided, and offers both answers", () => {
    const card = buildApprovalCard("bash", bashItem) as { elements: Array<Record<string, unknown>> };
    const raw = JSON.stringify(card);
    expect(raw).toContain("rm -rf build");
    expect(raw).toContain("清理构建产物");

    const action = card.elements.find((element) => element.tag === "action") as {
      actions: Array<{ text: { content: string }; value: unknown }>;
    };
    expect(action.actions.map((button) => button.text.content)).toEqual(["批准", "拒绝"]);
    expect(action.actions[0].value).toMatchObject({ decision: "approve", pendingType: "bash" });
  });

  it("names the tasks rather than dumping the plan object", () => {
    const raw = JSON.stringify(buildApprovalCard("plan", planItem));
    expect(raw).toContain("登录页");
    expect(raw).toContain(AGENT);
  });

  it("has no buttons once decided", () => {
    const card = buildApprovalCard("bash", bashItem, { decision: "reject", decidedBy: "张三" }) as {
      elements: Array<Record<string, unknown>>;
    };
    expect(card.elements.some((element) => element.tag === "action")).toBe(false);
    expect(JSON.stringify(card)).toContain("已拒绝");
  });

  it("approves through the same path the web UI uses, and records the operator id", async () => {
    const pending = registerPendingBash("conv_1", AGENT, "run_1", "rm -rf build", "/tmp/work", "清理");
    const id = [...((globalThis as unknown as { __agentMeldPendingBash: Map<string, unknown> })
      .__agentMeldPendingBash.keys())][0];

    const response = await handleCardAction(
      click({ kind: "approval", pendingType: "bash", pendingId: id, decision: "approve" })
    );

    await expect(pending).resolves.toBe(true);
    expect(response).toMatchObject({ toast: { type: "success" } });

    const row = getDatabase()
      .prepare("SELECT resolved_by FROM pending_approvals WHERE id = ?")
      .get(id) as { resolved_by: string | null } | undefined;
    expect(row?.resolved_by).toBe("ou_user");
  });

  it("refuses a decision from someone other than the owner", async () => {
    const pending = registerPendingBash("conv_1", AGENT, "run_1", "rm -rf build", "/tmp/work", "清理");
    const id = [...((globalThis as unknown as { __agentMeldPendingBash: Map<string, unknown> })
      .__agentMeldPendingBash.keys())][0];

    const response = await handleCardAction(
      click({ kind: "approval", pendingType: "bash", pendingId: id, decision: "approve" }, { openId: "ou_stranger", name: "别人" })
    );

    expect(response).toMatchObject({ toast: { type: "error" } });
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(settled).toBe(false);
  });

  it("says so when the approval is already gone", async () => {
    const response = await handleCardAction(
      click({ kind: "approval", pendingType: "bash", pendingId: "pb_missing", decision: "approve" })
    );
    expect(response).toMatchObject({ toast: { type: "info" } });
  });

  it("puts an approval in the room, and skips one whose conversation is not on a channel", async () => {
    const posted = await projectPendingApproval("bash", bashItem);
    expect(posted.status).toBe("posted");
    expect(sent).toHaveLength(1);

    const skipped = await projectPendingApproval("bash", { ...bashItem, conversationId: "conv_other" });
    expect(skipped).toMatchObject({ status: "skipped" });
  });

  it("posts an approval when one is raised", async () => {
    startChannelInteractions();
    sent.length = 0;

    registerPendingBash("conv_1", AGENT, "run_1", "ls", "/tmp", "看看");
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(sent).toHaveLength(1);
    expect(sent[0].input).toHaveProperty("card");
  });
});
