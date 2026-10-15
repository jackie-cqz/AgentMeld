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
import {
  clearPendingQuestionsForTests,
  getPendingQuestion,
  registerPendingQuestion
} from "@/server/pending-questions";
import { registerPendingBash, clearPendingBashForTests } from "@/server/pending-bash";
import {
  createChannelConversation,
  createConversation,
  createRun,
  upsertChannelBinding
} from "@/server/repositories";
import type { CardActionEvent } from "@larksuite/channel";
import { buildProgressCard } from "@/server/channels/feishu/progress";
import type {
  AgentRun,
  PendingBashCommand,
  PendingDispatchPlan,
  PendingQuestion,
  PendingWrite
} from "@/shared/types";

const { channelsByAgent, sent, updated } = vi.hoisted(() => ({
  channelsByAgent: new Map<string, unknown>(),
  sent: [] as Array<{ agentId: string; chatId: string; input: unknown }>,
  updated: [] as Array<{ messageId: string; card: unknown }>
}));

vi.mock("@/server/channels/feishu/registry", () => ({
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
    expect(isAuthorisedOperator(AGENT, "ou_owner", "cli_pm")).toBe(true);
  });

  it("refuses anyone else", () => {
    upsertChannelBinding({
      id: "cb_pm", agentId: AGENT, channel: "feishu", appId: "cli_pm", appSecret: "s",
      boundByOpenId: "ou_owner", now: 1
    });
    expect(isAuthorisedOperator(AGENT, "ou_other", "cli_pm")).toBe(false);
    expect(isAuthorisedOperator(AGENT, undefined, "cli_pm")).toBe(false);
  });

  it("fails closed when the owner is not recorded", () => {
    // Not knowing who owns the app is not a reason to accept everyone.
    upsertChannelBinding({
      id: "cb_pm", agentId: AGENT, channel: "feishu", appId: "cli_pm", appSecret: "s",
      boundByOpenId: null, now: 1
    });
    expect(isAuthorisedOperator(AGENT, "ou_anyone", "cli_pm")).toBe(false);
  });

  it("refuses an agent that is not bound at all", () => {
    expect(isAuthorisedOperator("ag_not_bound", "ou_owner", "cli_pm")).toBe(false);
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

    // The question's conversation has to be mapped to a chat, because a click
    // is refused unless it arrives in the chat the card belongs to.
    createConversation({
      id: "conv_1", title: "飞书群", mode: "group", agentIds: [AGENT],
      fsWriteApprovalMode: "auto", now: 1
    });
    createChannelConversation({
      id: "cc_1", channel: "feishu", chatId: "oc_1", conversationId: "conv_1", now: 1
    });

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

  /** The newest key in the pending store, which is the one just registered. */
  function latestKey(): string {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const store = (globalThis as any).__agentMeldPendingQuestions as Map<string, unknown>;
    return [...store.keys()][store.size - 1] as string;
  }

  function ask(options: { twoQuestions?: boolean; multi?: boolean } = {}) {
    const questions: PendingQuestion["questions"] = options.multi
      ? [
          {
            question: "要哪些能力？",
            header: "范围",
            multiSelect: true,
            options: [{ label: "搜索" }, { label: "翻译" }, { label: "总结" }]
          }
        ]
      : options.twoQuestions
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
      click({ kind: "ask_user", pendingId, questionIndex: 0, answer: "Vue" }),
      "cli_pm"
  );

    await expect(pending).resolves.toEqual({ "用哪个框架？": "Vue" });
    expect(response).toMatchObject({ toast: { type: "success" } });
  });

  it("collects several ticks and resolves them as one answer on confirm", async () => {
    // multiSelect used to degrade to a single choice: one click resolved the
    // whole question, and the other ticks were impossible to express.
    const { pending, pendingId } = ask({ multi: true });

    const first = await handleCardAction(
      click({ kind: "ask_user", pendingId, questionIndex: 0, toggle: "翻译", v: 0 }),
      "cli_pm"
    );
    // Ticking does not answer anything yet — the card comes back with the tick
    // visible so the person can keep going.
    expect(first).toHaveProperty("card");
    expect(JSON.stringify(first)).toContain("已选");

    await handleCardAction(
      click({ kind: "ask_user", pendingId, questionIndex: 0, toggle: "搜索", v: 1 }),
      "cli_pm"
    );
    const confirmed = await handleCardAction(
      click({ kind: "ask_user", pendingId, questionIndex: 0, confirm: true, v: 2 }),
      "cli_pm"
    );

    // Card order, joined the way the web page joins a multi-select answer.
    await expect(pending).resolves.toEqual({ "要哪些能力？": "搜索; 翻译" });
    expect(confirmed).toMatchObject({ toast: { type: "success" } });
  });

  it("unticks an option that was already ticked", async () => {
    const { pending, pendingId } = ask({ multi: true });
    await handleCardAction(click({ kind: "ask_user", pendingId, questionIndex: 0, toggle: "搜索", v: 0 }), "cli_pm");
    await handleCardAction(click({ kind: "ask_user", pendingId, questionIndex: 0, toggle: "搜索", v: 1 }), "cli_pm");
    const confirmed = await handleCardAction(
      click({ kind: "ask_user", pendingId, questionIndex: 0, confirm: true, v: 2 }),
      "cli_pm"
    );

    // Nothing ticked, so the confirm is refused rather than answering with "".
    expect(confirmed).toMatchObject({ toast: { type: "error" } });
    await expect(Promise.race([pending, Promise.resolve("pending")])).resolves.toBe("pending");
  });

  it("refuses a tick on a single-choice question", async () => {
    const { pending, pendingId } = ask();
    const response = await handleCardAction(
      click({ kind: "ask_user", pendingId, questionIndex: 0, toggle: "Vue", v: 0 }),
      "cli_pm"
    );
    expect(response).toMatchObject({ toast: { type: "error" } });
    await expect(Promise.race([pending, Promise.resolve("pending")])).resolves.toBe("pending");
  });

  it("refuses a tick for an option the card never offered", async () => {
    const { pendingId } = ask({ multi: true });
    const response = await handleCardAction(
      click({ kind: "ask_user", pendingId, questionIndex: 0, toggle: "删库", v: 0 }),
      "cli_pm"
    );
    expect(response).toMatchObject({ toast: { type: "error" } });
  });

  it("stamps a new version into the buttons so a repeated tick is not deduplicated", async () => {
    // The platform drops a card action whose value it has already seen. Select,
    // deselect, select again sends the same payload three times, so without a
    // version the third click would vanish.
    const { pendingId } = ask({ multi: true });
    const question = getPendingQuestion(pendingId)!.question;
    // The TOGGLE button's own value, not the confirm button's: asserting on the
    // whole card let a mutation that froze the toggle's version stay green,
    // because the confirm button carries a fresh version either way.
    const toggleValue = (card: object) => {
      const elements = (card as { elements: Array<Record<string, unknown>> }).elements;
      for (const element of elements) {
        const actions = (element.actions ?? []) as Array<{ value?: { toggle?: string; v?: number } }>;
        for (const action of actions) {
          if (action.value?.toggle) return action.value.v;
        }
      }
      return undefined;
    };

    const before = toggleValue(buildQuestionCard(question));
    await handleCardAction(click({ kind: "ask_user", pendingId, questionIndex: 0, toggle: "搜索", v: 0 }), "cli_pm");
    const after = toggleValue(buildQuestionCard(question));

    expect(before).toBe(0);
    expect(after).toBe(1);
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
      click({ kind: "ask_user", pendingId, questionIndex: 0, answer: "Vue" }),
      "cli_pm"
  );
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(partial).toMatchObject({ card: { type: "raw" } });
    expect(partial).not.toHaveProperty("toast");
    expect(settled).toBe(false);

    const complete = await handleCardAction(
      click({ kind: "ask_user", pendingId, questionIndex: 1, answer: "预览" }),
      "cli_pm"
  );
    expect(complete).toMatchObject({ toast: { type: "success" } });
    await expect(pending).resolves.toEqual({ "用哪个框架？": "Vue", "部署到哪？": "预览" });
  });

  it("makes a cancelled card inert, not just redrawn", async () => {
    // The review's find: the cancel path passed `cancelled` in and never used
    // it, so the card was rebuilt with no answers — which meant every button
    // still carried a value and stayed clickable. The old test asserted only
    // that updateCard was called, which is how it stayed green.
    const { pending, pendingId } = ask();
    void pending;
    const settled = buildQuestionCard(
      {
        id: pendingId, conversationId: "conv_1", agentId: AGENT, runId: "run_1", createdAt: 1,
        questions: [{ question: "用哪个框架？", header: "技术栈", options: [{ label: "Vue" }] }]
      },
      { cancelled: true }
    ) as { elements: Array<Record<string, unknown>> };

    const buttons = settled.elements
      .filter((element) => element.tag === "action")
      .flatMap((element) => (element.actions ?? []) as Array<{ value?: unknown }>);
    expect(buttons.length).toBeGreaterThan(0);
    for (const button of buttons) expect(button.value).toBeUndefined();
    expect(JSON.stringify(settled)).toContain("作废");
  });

  it("settles a cancelled card with no clickable buttons", async () => {
    ask();
    const pendingId = latestKey();
    startChannelInteractions();
    // Post a card so there is one to settle.
    const posted = await projectPendingQuestion({
      id: pendingId, conversationId: "conv_1", agentId: AGENT, runId: "run_1", createdAt: 1,
      questions: [{ question: "继续吗？", header: "确认", options: [{ label: "是" }] }]
    });
    expect(posted.status).toBe("posted");
    updated.length = 0;

    eventBus.publish({
      type: "ask_user.cancelled", conversationId: "conv_1", timestamp: 2,
      pendingId, runId: "run_1"
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(updated).toHaveLength(1);
    const raw = JSON.stringify(updated[0].card);
    expect(raw).toContain("作废");
    expect(raw).not.toContain('"answer"');
  });

  it("still resolves when two questions carry identical text", async () => {
    // The buffer was keyed by question TEXT, so two questions with the same
    // words collapsed into one key and the count could never reach the number
    // of questions — the run waited forever for an answer it already had.
    const pending = registerPendingQuestion("conv_1", AGENT, "run_1", [
      { question: "继续吗？", header: "一", options: [{ label: "是" }] },
      { question: "继续吗？", header: "二", options: [{ label: "否" }] }
    ]);
    const pendingId = latestKey();

    await handleCardAction(click({ kind: "ask_user", pendingId, questionIndex: 0, answer: "是" }), "cli_pm");
    const response = await handleCardAction(
      click({ kind: "ask_user", pendingId, questionIndex: 1, answer: "否" }),
      "cli_pm"
  );

    expect(response).toMatchObject({ toast: { type: "success" } });
    await expect(pending).resolves.toEqual({ "继续吗？": "否" });
  });

  it("takes the owner's latest answer when they click from two devices", async () => {
    // F2's "multi-client race", in the only form it can take: one person is
    // authorised, so the repeat is theirs. Last answer wins, and the card the
    // second device returns is the truth rather than that device's own guess.
    const pending = registerPendingQuestion("conv_1", AGENT, "run_1", [
      { question: "用哪个框架？", header: "一", options: [{ label: "Vue" }, { label: "React" }] },
      { question: "部署到哪？", header: "二", options: [{ label: "预览" }] }
    ]);
    const pendingId = latestKey();

    await handleCardAction(
      click({ kind: "ask_user", pendingId, questionIndex: 0, answer: "Vue" }, { openId: "ou_user", name: "甲" }),
      "cli_pm"
  );
    const second = await handleCardAction(
      click({ kind: "ask_user", pendingId, questionIndex: 0, answer: "React" }, { openId: "ou_user", name: "甲" }),
      "cli_pm"
  );

    // The card the second click returns shows React as CHOSEN. The assertion used
    // to be `toContain("React")`, which the button label satisfies on its own, so
    // it passed while the card showed no selection at all.
    expect(JSON.stringify(second)).toContain("已选择：**React**");

    await handleCardAction(
      click({ kind: "ask_user", pendingId, questionIndex: 1, answer: "预览" }, { openId: "ou_user", name: "甲" }),
      "cli_pm"
  );
    await expect(pending).resolves.toEqual({ "用哪个框架？": "React", "部署到哪？": "预览" });
  });

  /** Every button on a question card, one row per question, as the platform would hand it back. */
  function questionRows(card: object): Array<Array<{ label: string; value?: unknown }>> {
    const elements = (card as {
      elements: Array<{ tag: string; actions?: Array<{ text: { content: string }; value?: unknown }> }>;
    }).elements;
    return elements
      .filter((element) => element.tag === "action")
      .map((element) =>
        (element.actions ?? []).map((button) => ({ label: button.text.content, value: button.value }))
      );
  }

  function postedCard(pendingId: string): object {
    const entry = getPendingQuestion(pendingId);
    if (!entry) throw new Error("expected a pending question");
    return buildQuestionCard(entry.question);
  }

  it("keeps the rest of a card answerable after one question is answered", async () => {
    // The card used to strip EVERY button the moment any question had an answer,
    // so answering the first of two left the second with nothing to press — the
    // run waited, and only the web could finish it. The test that should have
    // caught it clicked the second question with a hand-built value, never with
    // one taken from the card that came back.
    const pending = registerPendingQuestion("conv_1", AGENT, "run_1", [
      { question: "用哪个框架？", header: "一", options: [{ label: "Vue" }, { label: "React" }] },
      { question: "部署到哪？", header: "二", options: [{ label: "预览" }, { label: "线上" }] }
    ]);
    const pendingId = latestKey();
    const fresh = questionRows(postedCard(pendingId));

    const partial = await handleCardAction(click(fresh[0][0].value), "cli_pm");
    const returned = (partial as { card: { data: object } }).card.data;
    const rows = questionRows(returned);

    // The question that was answered shows what was chosen and is no longer
    // clickable...
    expect(JSON.stringify(returned)).toContain("已选择：**Vue**");
    for (const button of rows[0]) expect(button.value).toBeUndefined();
    // ...and the other one is exactly as it was.
    expect(rows[1].map((button) => button.label)).toEqual(["预览", "线上"]);
    for (const button of rows[1]) {
      expect(decodeCardActionValue(button.value)).toMatchObject({ kind: "ask_user", questionIndex: 1 });
    }

    // Answering it with a value taken from the card that came BACK finishes it.
    await handleCardAction(click(rows[1][0].value), "cli_pm");
    await expect(pending).resolves.toEqual({ "用哪个框架？": "Vue", "部署到哪？": "预览" });
  });

  it("shows every choice and nothing clickable once the card is complete", async () => {
    registerPendingQuestion("conv_1", AGENT, "run_1", [
      { question: "用哪个框架？", header: "一", options: [{ label: "Vue" }] },
      { question: "部署到哪？", header: "二", options: [{ label: "预览" }] }
    ]);
    const pendingId = latestKey();
    const fresh = questionRows(postedCard(pendingId));

    const partial = await handleCardAction(click(fresh[0][0].value), "cli_pm");
    const rows = questionRows((partial as { card: { data: object } }).card.data);
    const done = await handleCardAction(click(rows[1][0].value), "cli_pm");

    const finalCard = (done as { card: { data: object } }).card.data;
    expect(JSON.stringify(finalCard)).toContain("已选择：**Vue**");
    expect(JSON.stringify(finalCard)).toContain("已选择：**预览**");
    for (const row of questionRows(finalCard)) {
      for (const button of row) expect(button.value).toBeUndefined();
    }
  });

  it("tells two questions with identical text apart", async () => {
    // Keyed by text, answering one marked BOTH answered, and the second could
    // never be answered from the card.
    registerPendingQuestion("conv_1", AGENT, "run_1", [
      { question: "继续吗？", header: "一", options: [{ label: "是" }] },
      { question: "继续吗？", header: "二", options: [{ label: "否" }] }
    ]);
    const pendingId = latestKey();
    const fresh = questionRows(postedCard(pendingId));

    const partial = await handleCardAction(click(fresh[0][0].value), "cli_pm");
    const rows = questionRows((partial as { card: { data: object } }).card.data);

    expect(rows[0][0].value).toBeUndefined();
    expect(decodeCardActionValue(rows[1][0].value)).toMatchObject({
      kind: "ask_user",
      questionIndex: 1
    });
  });

  it("says so, rather than failing silently, when the question is already gone", async () => {
    // A card left in the room after the run moved on: the click must land as a
    // visible message, not as nothing happening.
    const response = await handleCardAction(
      click({ kind: "ask_user", pendingId: "pq_missing", questionIndex: 0, answer: "Vue" }),
      "cli_pm"
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
      click({ kind: "ask_user", pendingId, questionIndex: 0, answer: "Vue" }, { openId: "ou_user", name: "任意昵称" }),
      "cli_pm"
  );

    const row = getDatabase()
      .prepare("SELECT resolved_by FROM pending_approvals WHERE id = ?")
      .get(pendingId) as { resolved_by: string | null } | undefined;
    // App-scoped (#24): the open_id alone is meaningless outside the app that
    // issued it, so the binding's appId is part of the recorded identity.
    expect(row?.resolved_by).toBe("feishu:cli_pm:ou_user");
    await expect(pending).resolves.toEqual({ "用哪个框架？": "Vue" });
  });

  it("scopes the identity by the app that delivered the click", async () => {
    // #24: an open_id is only meaningful inside the app that issued it. The
    // identity records the DELIVERING app, which authorization has already
    // proved is the bound one.
    const { pending, pendingId } = ask();

    await handleCardAction(
      click({ kind: "ask_user", pendingId, questionIndex: 0, answer: "Vue" }, { openId: "ou_user", name: "任意昵称" }),
      "cli_pm"
    );

    const row = getDatabase()
      .prepare("SELECT resolved_by FROM pending_approvals WHERE id = ?")
      .get(pendingId) as { resolved_by: string | null } | undefined;
    expect(row?.resolved_by).toBe("feishu:cli_pm:ou_user");
    await expect(pending).resolves.toEqual({ "用哪个框架？": "Vue" });
  });

  it("follows the delivering app when the agent is rebound", async () => {
    // Same open_id string, a different app: bound to cli_other and delivered
    // by cli_other, the identity names that app — the app is part of who this
    // is, not a lookup performed against whatever the row says later.
    upsertChannelBinding({
      id: "cb_pm", agentId: AGENT, channel: "feishu", appId: "cli_other", appSecret: "s",
      boundByOpenId: "ou_user", now: 2
    });
    const { pending, pendingId } = ask();

    await handleCardAction(
      click({ kind: "ask_user", pendingId, questionIndex: 0, answer: "Vue" }, { openId: "ou_user", name: "任意昵称" }),
      "cli_other"
    );

    const row = getDatabase()
      .prepare("SELECT resolved_by FROM pending_approvals WHERE id = ?")
      .get(pendingId) as { resolved_by: string | null } | undefined;
    expect(row?.resolved_by).toBe("feishu:cli_other:ou_user");
    await expect(pending).resolves.toEqual({ "用哪个框架？": "Vue" });
  });

  it("refuses a click delivered by an app the agent is no longer bound to", async () => {
    // The stale-delivery case: a card from the old app keeps working after a
    // rebind. The open_id string is identical, so the old check would have
    // accepted it and attributed the decision to the CURRENT app — naming
    // someone else. Authorization now requires the delivering app to be the
    // bound one, so this fails closed.
    upsertChannelBinding({
      id: "cb_pm", agentId: AGENT, channel: "feishu", appId: "cli_other", appSecret: "s",
      boundByOpenId: "ou_user", now: 2
    });
    const { pending, pendingId } = ask();

    const response = await handleCardAction(
      click({ kind: "ask_user", pendingId, questionIndex: 0, answer: "Vue" }, { openId: "ou_user", name: "任意昵称" }),
      "cli_pm"
    );

    expect(response).toMatchObject({ toast: { type: "error" } });
    const row = getDatabase()
      .prepare("SELECT resolved_by, status FROM pending_approvals WHERE id = ?")
      .get(pendingId) as { resolved_by: string | null; status: string } | undefined;
    expect(row?.status).toBe("pending");
    expect(row?.resolved_by).toBeNull();
    // The question is still pending, so the run is still waiting on it.
    void pending.catch(() => undefined);
  });

  it("refuses an answer the card never offered", async () => {
    // The card value comes back from the platform, so it can be forwarded or
    // crafted. Accepting any string would let arbitrary text into the run as
    // though the user had chosen it.
    const { pending, pendingId } = ask();

    const response = await handleCardAction(
      click({ kind: "ask_user", pendingId, questionIndex: 0, answer: "我编的" }),
      "cli_pm"
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

    const event = click({ kind: "ask_user", pendingId, questionIndex: 0, answer: "Vue" });
    const response = await handleCardAction({ ...event, chatId: "oc_elsewhere" }, "cli_pm");

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
      click({ kind: "ask_user", pendingId, questionIndex: 0, answer: "Vue" }, { openId: "ou_stranger", name: "别人" }),
      "cli_pm"
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
      { messageId: "om", chatId: "oc_1", action: { value: { kind: "ask_user", pendingId, questionIndex: 0, answer: "Vue" }, tag: "button" } } as any,
      "cli_pm"
    );

    expect(response).toMatchObject({ toast: { type: "error" } });
  });

  it("ignores a click it cannot attribute to one of its own cards", async () => {
    expect(await handleCardAction(click({ kind: "something_else" }), "cli_pm")).toBeUndefined();
    expect(await handleCardAction(click(null), "cli_pm")).toBeUndefined();
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
    await handleCardAction(click({ kind: "ask_user", pendingId: id, questionIndex: 0, answer: "是" }), "cli_pm");
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
    await handleCardAction(click({ kind: "ask_user", pendingId: id, questionIndex: 0, answer: "是" }), "cli_pm");
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
      click({ kind: "approval", pendingType: "bash", pendingId: id, decision: "approve" }),
      "cli_pm"
  );

    await expect(pending).resolves.toBe(true);
    expect(response).toMatchObject({ toast: { type: "success" } });

    const row = getDatabase()
      .prepare("SELECT resolved_by FROM pending_approvals WHERE id = ?")
      .get(id) as { resolved_by: string | null } | undefined;
    expect(row?.resolved_by).toBe("feishu:cli_pm:ou_user");
  });

  it("refuses a decision from someone other than the owner", async () => {
    const pending = registerPendingBash("conv_1", AGENT, "run_1", "rm -rf build", "/tmp/work", "清理");
    const id = [...((globalThis as unknown as { __agentMeldPendingBash: Map<string, unknown> })
      .__agentMeldPendingBash.keys())][0];

    const response = await handleCardAction(
      click({ kind: "approval", pendingType: "bash", pendingId: id, decision: "approve" }, { openId: "ou_stranger", name: "别人" }),
      "cli_pm"
  );

    expect(response).toMatchObject({ toast: { type: "error" } });
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(settled).toBe(false);
  });

  it("escapes what the model wrote into an approval card", async () => {
    // The escaping claim covered only the question card. Approval cards
    // interpolate a command, a path, a cwd and a reason — all model- or
    // tool-controlled — and none of it was escaped.
    const raw = JSON.stringify(
      buildApprovalCard("bash", {
        ...bashItem,
        command: "echo <at id=all></at>",
        cwd: "/tmp/<at id=all></at>",
        reason: "<at id=all></at>"
      })
    );

    // The command keeps its shape — approving `echo a` when the real command is
    // `echo a > b` would be worse than any markup risk — so only `<` goes, and
    // a tag cannot form from half of itself.
    expect(raw).not.toContain("<at id=all></at>");
    expect(raw).toContain("echo");
    expect(raw).not.toContain("at id=all></at>");
  });

  it("keeps a redirection readable, because that is what is being approved", () => {
    const raw = JSON.stringify(
      buildApprovalCard("bash", { ...bashItem, command: "echo done > out.txt && cat a | wc -l" })
    );
    expect(raw).toContain("> out.txt");
    expect(raw).toContain("| wc -l");
  });

  it("refuses an approval click that arrived in a different chat", async () => {
    const pending = registerPendingBash("conv_1", AGENT, "run_1", "ls", "/tmp", "看看");
    const id = [...((globalThis as unknown as { __agentMeldPendingBash: Map<string, unknown> })
      .__agentMeldPendingBash.keys())][0];

    const event = click({ kind: "approval", pendingType: "bash", pendingId: id, decision: "approve" });
    const response = await handleCardAction({ ...event, chatId: "oc_elsewhere" }, "cli_pm");

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
      click({ kind: "approval", pendingType: "bash", pendingId: "pb_missing", decision: "approve" }),
      "cli_pm"
  );
    expect(response).toMatchObject({ toast: { type: "info" } });
  });

  it("announces the decision the way the web routes do", async () => {
    // The web UI clears a pending when it sees the resolved event. The resolve
    // ROUTES publish it; the functions underneath do not — so a decision taken
    // in the room left the web showing a pending that was already settled.
    const pending = registerPendingBash("conv_1", AGENT, "run_1", "ls", "/tmp", "看看");
    const id = [...((globalThis as unknown as { __agentMeldPendingBash: Map<string, unknown> })
      .__agentMeldPendingBash.keys())][0];
    void pending;

    const seen: string[] = [];
    const unsub = eventBus.subscribe((entry) => seen.push(entry.event.type));

    await handleCardAction(
      click({ kind: "approval", pendingType: "bash", pendingId: id, decision: "approve" }),
      "cli_pm"
  );
    unsub();

    expect(seen).toContain("bash_command.resolved");
  });

  it("settles the room's approval card when the decision is taken on the web", async () => {
    // The same defect the question card had, on the approval path: a card
    // approved from the web stayed live in the room.
    const pending = registerPendingBash("conv_1", AGENT, "run_1", "ls", "/tmp", "看看");
    void pending;
    const id = [...((globalThis as unknown as { __agentMeldPendingBash: Map<string, unknown> })
      .__agentMeldPendingBash.keys())][0];

    // The settle path lives in the subscription, so it has to be running.
    startChannelInteractions();
    const posted = await projectPendingApproval("bash", {
      id, conversationId: "conv_1", agentId: AGENT, runId: "run_1",
      command: "ls", cwd: "/tmp", reason: "看看", createdAt: 1
    });
    expect(posted.status).toBe("posted");
    updated.length = 0;

    eventBus.publish({
      type: "bash_command.resolved", conversationId: "conv_1", timestamp: 2,
      pendingId: id, approved: true
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(updated).toHaveLength(1);
    const raw = JSON.stringify(updated[0].card);
    expect(raw).toContain("已批准");
    // And no buttons are left to press.
    expect((updated[0].card as { elements: Array<Record<string, unknown>> }).elements
      .some((element) => element.tag === "action")).toBe(false);
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

describe("run card actions through the card handler", () => {
  let teardown: () => void;

  beforeEach(() => {
    teardown = setupTestDatabase("agentmeld-channel-run-actions-");
    sent.length = 0;
    updated.length = 0;
    channelsByAgent.clear();
    stopChannelInteractionsForTests();

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

  function seedRun() {
    return createRun({
      id: `run_${Math.random().toString(36).slice(2, 8)}`,
      conversationId: "conv_1",
      agentId: AGENT,
      triggerMessageId: null,
      parentRunId: null,
      status: "running",
      now: Date.now()
    });
  }

  it("decodes a status value, and refuses one with no run", () => {
    expect(decodeCardActionValue({ kind: "run_status", runId: "run_1" })).toEqual({
      kind: "run_status",
      runId: "run_1"
    });
    expect(decodeCardActionValue({ kind: "run_status" })).toBeNull();
    expect(decodeCardActionValue({ kind: "run_status", runId: "" })).toBeNull();
  });

  it("still decodes a cancel value now that the two share a branch", () => {
    expect(decodeCardActionValue({ kind: "cancel_run", runId: "run_1" })).toEqual({
      kind: "cancel_run",
      runId: "run_1"
    });
  });

  it("routes a status click to the status handler", async () => {
    const run = seedRun();

    const response = await handleCardAction(click({ kind: "run_status", runId: run.id }), "cli_pm");

    expect(response).toMatchObject({ toast: { type: "info" } });
    expect(JSON.stringify(response)).toContain("已运行");
  });

  it("lets anyone in the room ask for status, because it shows nothing the room cannot see", async () => {
    // Acting on the run is the owner's; asking about it is not.
    const run = seedRun();

    const response = await handleCardAction(
      click({ kind: "run_status", runId: run.id }, { openId: "ou_stranger", name: "别人" }),
      "cli_pm"
  );

    expect(response).toMatchObject({ toast: { type: "info" } });
  });

  it("refuses a status click that came from another chat", async () => {
    const run = seedRun();
    const event = click({ kind: "run_status", runId: run.id });

    const response = await handleCardAction({ ...event, chatId: "oc_elsewhere" }, "cli_pm");

    expect(response).toMatchObject({ toast: { type: "error" } });
  });

  it("refuses a cancel click from another chat, even from the owner", async () => {
    // The owner check says WHO may cancel; it said nothing about WHERE the click
    // came from, so a forwarded card could cancel a run from a room the clicker
    // was not in. Every other card action already checked.
    const run = seedRun();
    const event = click({ kind: "cancel_run", runId: run.id });

    const response = await handleCardAction({ ...event, chatId: "oc_elsewhere" }, "cli_pm");

    expect(response).toMatchObject({ toast: { type: "error" } });
    expect(JSON.stringify(response)).toContain("不属于这个群");
  });

  it("refuses a cancel click when the run's conversation is not mapped to a chat", async () => {
    // Fail closed, like the question and approval cards. The mapping can be
    // missing — a plain conversation, or a channel conversation whose row is
    // gone — and that must read as "not this card", not as "any card will do".
    createConversation({
      id: "conv_plain", title: "普通会话", mode: "group", agentIds: [AGENT],
      fsWriteApprovalMode: "auto", now: 1
    });
    const run = createRun({
      id: "run_plain", conversationId: "conv_plain", agentId: AGENT,
      triggerMessageId: null, parentRunId: null, status: "running", now: Date.now()
    });

    const response = await handleCardAction(click({ kind: "cancel_run", runId: run.id }), "cli_pm");

    expect(response).toMatchObject({ toast: { type: "error" } });
    expect(JSON.stringify(response)).toContain("不属于这个群");
  });

  it("refuses a cancel click delivered by an app the agent is no longer bound to", async () => {
    // The same stale-delivery rule the question and approval cards follow: the
    // open_id string matches the owner, but it was issued by an app that is no
    // longer the binding. Without the app check this click reached abortRun.
    upsertChannelBinding({
      id: "cb_pm", agentId: AGENT, channel: "feishu", appId: "cli_other", appSecret: "s",
      boundByOpenId: "ou_user", now: 2
    });
    const run = seedRun();

    const response = await handleCardAction(click({ kind: "cancel_run", runId: run.id }), "cli_old");

    expect(response).toMatchObject({ toast: { type: "error" } });
    expect(JSON.stringify(response)).toContain("已经不生效的应用");
  });

  it("lets a cancel click from the right chat through to the owner check", async () => {
    // The control for the test above: same click, right chat, and it gets past
    // the chat guard. Nothing is actually running, so it lands on "already over".
    const run = seedRun();

    const response = await handleCardAction(click({ kind: "cancel_run", runId: run.id }), "cli_pm");

    expect(response).toMatchObject({ toast: { type: "info" } });
    expect(JSON.stringify(response)).toContain("已经结束");
  });
});

/**
 * A card is only as good as its buttons' values surviving the trip back.
 *
 * The cancel button shipped dead: the decoder required a `pendingId` of every
 * value, the cancel button carries a `runId`, and every click was read as
 * unrecognised and dropped. The tests built values by hand and handed them to the
 * handler, so a builder and a decoder that disagreed could never be noticed.
 * These take the values from the cards the builders actually produce.
 */
describe("every button a card offers can be read back", () => {
  function buttonValues(card: object): unknown[] {
    const elements = (card as {
      elements: Array<{ tag: string; actions?: Array<{ value?: unknown }> }>;
    }).elements;
    return elements
      .filter((element) => element.tag === "action")
      .flatMap((element) => element.actions ?? [])
      .map((button) => button.value);
  }

  it("on a question card", () => {
    const question: PendingQuestion = {
      id: "pq_1", conversationId: "conv_1", agentId: AGENT, runId: "run_1", createdAt: 1,
      questions: [{ question: "用哪个框架？", header: "技术栈", options: [{ label: "Vue" }, { label: "React" }] }]
    };

    const values = buttonValues(buildQuestionCard(question));

    expect(values).toHaveLength(2);
    for (const value of values) {
      expect(decodeCardActionValue(value)).toMatchObject({ kind: "ask_user", pendingId: "pq_1" });
    }
  });

  it("on an approval card, for each kind of thing that can wait", () => {
    const bash: PendingBashCommand = {
      id: "pb_1", conversationId: "conv_1", agentId: AGENT, runId: "run_1",
      command: "ls", cwd: "/tmp", reason: "看看", createdAt: 1
    };
    const plan: PendingDispatchPlan = {
      id: "pp_1", conversationId: "conv_1", runId: "run_1", createdAt: 1,
      plan: [{ id: "t1", agentId: AGENT, task: "设计登录页", dependsOn: [] }]
    };
    const write: PendingWrite = {
      id: "pw_1", conversationId: "conv_1", agentId: AGENT, runId: "run_1",
      path: "a.txt", absolutePath: "/tmp/a.txt", oldContent: null, newContent: "x", createdAt: 1
    };

    for (const [kind, item] of [["bash", bash], ["plan", plan], ["write", write]] as const) {
      const values = buttonValues(buildApprovalCard(kind, item));
      expect(values).toHaveLength(2);
      for (const value of values) {
        expect(decodeCardActionValue(value)).toMatchObject({
          kind: "approval",
          pendingType: kind,
          pendingId: item.id
        });
      }
    }
  });

  it("on a progress card — the cancel and status buttons, which carry a run and no pending id", () => {
    const run: AgentRun = {
      id: "run_9", conversationId: "conv_1", agentId: AGENT, triggerMessageId: null,
      parentRunId: null, status: "running", stage: null, error: null, usage: null,
      interrupted: false, errorCategory: null, retryable: false, startedAt: 1,
      finishedAt: null, createdAt: 1, updatedAt: 1
    };

    const decoded = buttonValues(buildProgressCard(run, "PM 小灰")).map((value) =>
      decodeCardActionValue(value)
    );

    expect(decoded).toHaveLength(2);
    expect(decoded).toContainEqual({ kind: "cancel_run", runId: "run_9" });
    expect(decoded).toContainEqual({ kind: "run_status", runId: "run_9" });
  });
});
