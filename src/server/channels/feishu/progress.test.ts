import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setupTestDatabase } from "@/test/test-database";
import {
  buildProgressCard,
  cancelRunFromCard,
  collectRunStatus,
  describeRunStatus,
  formatElapsed,
  handleRunStatusClick,
  projectRunStarted,
  settleRunCard,
  stageLabel,
  startChannelProgress,
  stopChannelProgressForTests,
  type RunStatusSnapshot
} from "@/server/channels/feishu/progress";
import { clearPendingQuestionsForTests, registerPendingQuestion } from "@/server/pending-questions";
import { clearPendingBashForTests, registerPendingBash } from "@/server/pending-bash";
import { clearPendingWritesForTests, registerPendingWrite } from "@/server/pending-writes";
import { clearPendingPlansForTests, registerPendingPlan } from "@/server/dispatch-plan-manager";
import { setChannelProjectionPaused } from "@/server/channels/feishu/projection";
import {
  createChannelConversation,
  createConversation,
  createRun,
  getRun,
  updateRunStatus,
  upsertChannelBinding
} from "@/server/repositories";
import type { AgentRun } from "@/shared/types";

const { channelsByAgent, sent, updated, connections, abortRunMock, gate } = vi.hoisted(() => ({
  channelsByAgent: new Map<string, unknown>(),
  sent: [] as Array<{ agentId: string; chatId: string; input: unknown }>,
  updated: [] as Array<{ messageId: string; card: unknown }>,
  connections: [] as Array<{ agentId: string; botName: string | null }>,
  abortRunMock: vi.fn(),
  // Holds the NEXT card update open until released, so a test can decide the
  // order in which two updates to one card land.
  gate: { next: null as Promise<void> | null }
}));

vi.mock("@/server/channels/feishu/registry", () => ({
  getFeishuChannelForAgent: (agentId: string) => {
    if (!channelsByAgent.has(agentId)) return null;
    return {
      send: async (chatId: string, input: unknown) => {
        sent.push({ agentId, chatId, input });
        return { messageId: `om_${sent.length}` };
      },
      updateCard: async (messageId: string, card: unknown) => {
        const wait = gate.next;
        gate.next = null;
        if (wait) await wait;
        updated.push({ messageId, card });
      }
    };
  },
  listFeishuConnections: () => connections
}));

vi.mock("@/server/agent-runner", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/agent-runner")>();
  return { ...actual, abortRun: (runId: string) => abortRunMock(runId) };
});

const AGENT = "ag_pm";

describe("buildProgressCard", () => {
  const run = {
    id: "run_1",
    conversationId: "conv_1",
    agentId: AGENT,
    parentRunId: null,
    status: "running",
    stage: "正在读取文件",
    triggerMessageId: null,
    error: null,
    usage: null,
    interrupted: false,
    errorCategory: null,
    retryable: false,
    startedAt: 1,
    finishedAt: null,
    createdAt: 1,
    updatedAt: 1
  } as AgentRun;

  it("names the agent and what it is doing", () => {
    const raw = JSON.stringify(buildProgressCard(run, "PM 小灰"));
    expect(raw).toContain("PM 小灰");
    expect(raw).toContain("正在读取文件");
  });

  it("offers a cancel button that carries the run", () => {
    const card = buildProgressCard(run, "PM 小灰") as { elements: Array<Record<string, unknown>> };
    const action = card.elements.find((element) => element.tag === "action") as {
      actions: Array<{ value: { kind: string; runId: string } }>;
    };
    // Found by what it does, not by where it sits: the status button shares the
    // row and the order is a layout choice.
    const cancel = action.actions.find((button) => button.value.kind === "cancel_run");
    expect(cancel?.value).toEqual({ kind: "cancel_run", runId: "run_1" });
  });

  it("offers a status button that carries the run", () => {
    const card = buildProgressCard(run, "PM 小灰") as { elements: Array<Record<string, unknown>> };
    const action = card.elements.find((element) => element.tag === "action") as {
      actions: Array<{ value: { kind: string; runId: string } }>;
    };
    const status = action.actions.find((button) => button.value.kind === "run_status");
    expect(status?.value).toEqual({ kind: "run_status", runId: "run_1" });
  });

  it("stops offering cancel once the run is over", () => {
    // A finished run offering cancel would be a lie the click has to correct.
    const card = buildProgressCard(run, "PM 小灰", "complete") as {
      elements: Array<Record<string, unknown>>;
    };
    expect(card.elements.some((element) => element.tag === "action")).toBe(false);
    expect(JSON.stringify(card)).toContain("已完成");
  });

  it("falls back to the agent id when the room does not know a name", () => {
    expect(JSON.stringify(buildProgressCard(run, null))).toContain(AGENT);
  });
});

describe("run progress in a room", () => {
  let teardown: () => void;

  beforeEach(() => {
    teardown = setupTestDatabase("agentmeld-channel-progress-");
    sent.length = 0;
    updated.length = 0;
    connections.length = 0;
    channelsByAgent.clear();
    abortRunMock.mockReset();
    stopChannelProgressForTests();
    setChannelProjectionPaused(false);

    createConversation({
      id: "conv_1", title: "飞书群", mode: "group", agentIds: [AGENT],
      fsWriteApprovalMode: "auto", now: 1
    });
    createChannelConversation({
      id: "cc_1", channel: "feishu", chatId: "oc_1", conversationId: "conv_1", now: 1
    });
    channelsByAgent.set(AGENT, {});
    connections.push({ agentId: AGENT, botName: "PM 小灰" });
    upsertChannelBinding({
      id: "cb_pm", agentId: AGENT, channel: "feishu", appId: "cli_pm", appSecret: "s",
      boundByOpenId: "ou_user", now: 1
    });
  });

  afterEach(() => {
    stopChannelProgressForTests();
    teardown();
  });

  /** A real run row, so `getRun` has something to read. */
  function seedRun(overrides: { parentRunId?: string | null } = {}) {
    const now = Date.now();
    return createRun({
      id: `run_${Math.random().toString(36).slice(2, 8)}`,
      conversationId: "conv_1",
      agentId: AGENT,
      triggerMessageId: null,
      parentRunId: overrides.parentRunId ?? null,
      status: "running",
      now
    });
  }

  it("posts one card for a top-level run", async () => {
    const run = seedRun();

    const outcome = await projectRunStarted(run);

    expect(outcome.status).toBe("posted");
    expect(sent).toHaveLength(1);
    expect(sent[0].chatId).toBe("oc_1");
  });

  it("files the progress card under the run's conversation and agent", async () => {
    const { clearDeliveryHealthForTests, getDeliveryHealth } = await import(
      "@/server/channels/feishu/delivery"
    );
    clearDeliveryHealthForTests();
    const run = seedRun();

    await projectRunStarted(run);

    const [entry] = getDeliveryHealth();
    expect(entry).toMatchObject({ conversationId: "conv_1", agentId: AGENT, sent: 1 });
    clearDeliveryHealthForTests();
  });

  it("posts nothing for a child run", async () => {
    // A five-task plan would otherwise put six cards in the room.
    const run = seedRun({ parentRunId: "run_parent" });

    const outcome = await projectRunStarted(run);

    expect(outcome).toEqual({ status: "skipped", reason: "child run" });
    expect(sent).toHaveLength(0);
  });

  it("stays silent for a conversation that is not on a channel", async () => {
    const run = seedRun();
    const outcome = await projectRunStarted({ ...run, conversationId: "conv_other" });
    expect(outcome).toMatchObject({ status: "skipped" });
  });

  it("stays silent rather than reporting progress as the wrong agent", async () => {
    channelsByAgent.clear();
    const run = seedRun();
    const outcome = await projectRunStarted(run);
    expect(outcome).toEqual({ status: "skipped", reason: "agent has no live channel" });
  });

  it("yields to the pause switch, which is an instruction to stop", async () => {
    setChannelProjectionPaused(true);
    const outcome = await projectRunStarted(seedRun());
    expect(outcome).toEqual({ status: "skipped", reason: "paused" });
  });

  it("closes the card when the run ends, and forgets it", async () => {
    const run = seedRun();
    await projectRunStarted(run);

    await settleRunCard({ ...run, status: "complete" });

    expect(updated).toHaveLength(1);
    expect(JSON.stringify(updated[0].card)).toContain("已完成");
    // Settling twice must not offer a second update for a card already closed.
    updated.length = 0;
    await settleRunCard({ ...run, status: "complete" });
    expect(updated).toHaveLength(0);
  });

  it("does not settle a card while outbound is paused", async () => {
    // Settling is outbound too, and nothing pinned that — removing the check
    // from `settleRunCard` left every test passing, so a paused channel would
    // have kept editing cards in the room.
    const run = seedRun();
    await projectRunStarted(run);
    updated.length = 0;
    setChannelProjectionPaused(true);

    await settleRunCard({ ...run, status: "complete" }, "complete");

    expect(updated).toHaveLength(0);
    setChannelProjectionPaused(false);
  });

  it("has nothing to settle for a run it never posted", async () => {
    await settleRunCard(seedRun());
    expect(updated).toHaveLength(0);
  });

  describe("cancelling from the card", () => {
    it("lets the owner cancel", () => {
      const run = seedRun();
      abortRunMock.mockReturnValue(true);

      expect(cancelRunFromCard(run.id, "ou_user", AGENT)).toEqual({ ok: true });
      expect(abortRunMock).toHaveBeenCalledWith(run.id);
    });

    it("refuses anyone else", () => {
      // Cancelling somebody else's work is not a spectator action.
      const run = seedRun();
      abortRunMock.mockReturnValue(true);

      const outcome = cancelRunFromCard(run.id, "ou_stranger", AGENT);

      expect(outcome.ok).toBe(false);
      expect(abortRunMock).not.toHaveBeenCalled();
    });

    it("refuses a click carrying no operator", () => {
      const run = seedRun();
      expect(cancelRunFromCard(run.id, undefined, AGENT).ok).toBe(false);
      expect(abortRunMock).not.toHaveBeenCalled();
    });

    it("reports a run that already finished rather than pretending", () => {
      const run = seedRun();
      abortRunMock.mockReturnValue(false);

      const outcome = cancelRunFromCard(run.id, "ou_user", AGENT);

      expect(outcome).toEqual({ ok: false, message: "这次运行已经结束了。" });
    });
  });

  it("subscribes once and follows a run from start to end", async () => {
    const first = startChannelProgress();
    expect(startChannelProgress()).toBe(first);

    const run = seedRun();
    const { eventBus } = await import("@/server/event-bus");
    eventBus.publish({
      type: "run.start",
      conversationId: "conv_1",
      timestamp: Date.now(),
      runId: run.id,
      agentId: AGENT,
      triggerMessageId: null
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(sent).toHaveLength(1);

    eventBus.publish({
      type: "run.end",
      conversationId: "conv_1",
      timestamp: Date.now(),
      runId: run.id,
      status: "complete"
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(updated).toHaveLength(1);
    expect(getRun(run.id)?.status).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// The status button
// ---------------------------------------------------------------------------

function makeRun(overrides: Partial<AgentRun> = {}): AgentRun {
  return {
    id: "run_1",
    conversationId: "conv_1",
    agentId: AGENT,
    triggerMessageId: null,
    parentRunId: null,
    status: "running",
    stage: null,
    error: null,
    usage: null,
    interrupted: false,
    errorCategory: null,
    retryable: false,
    startedAt: 1,
    finishedAt: null,
    createdAt: 1,
    updatedAt: 1,
    ...overrides
  };
}

function snapshot(overrides: Partial<RunStatusSnapshot> = {}): RunStatusSnapshot {
  return {
    run: makeRun(),
    now: 130_001,
    children: { queued: 0, running: 0, complete: 0, failed: 0, aborted: 0 },
    childTotal: 0,
    waiting: { questions: 0, approvals: 0 },
    ...overrides
  };
}

describe("formatElapsed", () => {
  it("reads in the unit a person would say", () => {
    expect(formatElapsed(0)).toBe("0 秒");
    expect(formatElapsed(59_999)).toBe("59 秒");
    expect(formatElapsed(60_000)).toBe("1 分 0 秒");
    expect(formatElapsed(130_000)).toBe("2 分 10 秒");
    expect(formatElapsed(3_599_000)).toBe("59 分 59 秒");
    expect(formatElapsed(3_600_000)).toBe("1 小时 0 分");
    expect(formatElapsed(7_500_000)).toBe("2 小时 5 分");
  });

  it("never goes negative when two clocks disagree", () => {
    expect(formatElapsed(-5000)).toBe("0 秒");
  });
});

describe("stageLabel", () => {
  it("says nothing when there is no stage", () => {
    expect(stageLabel(null)).toBeNull();
  });

  it("puts each conductor stage in words the room can read", () => {
    // The card used to show these raw, so a Chinese-speaking room read "dispatch".
    expect(stageLabel("dispatch")).toBe("正在执行各个任务");
    expect(stageLabel("recovery")).toBe("正在为失败的任务重新规划");
    expect(stageLabel("aggregate")).toBe("正在汇总结果");
  });

  it("shows an unfamiliar stage as itself, escaped, rather than hiding it", () => {
    const label = stageLabel("<at id=all></at>review");
    expect(label).toContain("review");
    expect(label).not.toContain("<");
  });
});

describe("describeRunStatus", () => {
  it("says only how long a plain run has been going", () => {
    expect(describeRunStatus(snapshot())).toEqual(["已运行 2 分 10 秒"]);
  });

  it("names the stage of a conductor run", () => {
    const lines = describeRunStatus(snapshot({ run: makeRun({ stage: "dispatch" }) }));
    expect(lines).toContain("正在执行各个任务");
  });

  it("counts the child tasks, and leaves out the zeroes", () => {
    const lines = describeRunStatus(
      snapshot({ childTotal: 5, children: { queued: 1, running: 2, complete: 2, failed: 0, aborted: 0 } })
    );
    expect(lines).toContain("子任务 5 个：完成 2 · 进行中 2 · 排队 1");
  });

  it("surfaces a failed or cancelled task, which is what someone asking is after", () => {
    const lines = describeRunStatus(
      snapshot({ childTotal: 3, children: { queued: 0, running: 1, complete: 0, failed: 1, aborted: 1 } })
    );
    expect(lines.join("\n")).toContain("失败 1");
    expect(lines.join("\n")).toContain("已取消 1");
  });

  it("says what is waiting on a person", () => {
    expect(describeRunStatus(snapshot({ waiting: { questions: 1, approvals: 2 } }))).toContain(
      "等待处理：1 个提问、2 项审批"
    );
    expect(describeRunStatus(snapshot({ waiting: { questions: 0, approvals: 2 } }))).toContain(
      "等待处理：2 项审批"
    );
  });

  it("says nothing about waiting when nothing is", () => {
    expect(describeRunStatus(snapshot()).join("\n")).not.toContain("等待处理");
  });

  it("reports how long a finished run took, and no stage", () => {
    // A finished run's stage would read as present tense on a card that is over.
    const lines = describeRunStatus(
      snapshot({ run: makeRun({ status: "complete", stage: "aggregate", finishedAt: 90_001 }) })
    );
    expect(lines).toEqual(["用时 1 分 30 秒"]);
  });
});

describe("the progress card with a reading", () => {
  it("shows the reading while the run is live", () => {
    const card = buildProgressCard(
      makeRun(),
      "PM 小灰",
      undefined,
      snapshot({ childTotal: 2, children: { queued: 0, running: 1, complete: 1, failed: 0, aborted: 0 } })
    );
    const raw = JSON.stringify(card);
    expect(raw).toContain("已运行 2 分 10 秒");
    expect(raw).toContain("子任务 2 个");
    // And still offers both buttons: it is a refresh, not a settle.
    expect(raw).toContain("查看状态");
    expect(raw).toContain("取消运行");
  });

  it("shows how long a settled card took, with no buttons and no stage", () => {
    const card = buildProgressCard(
      makeRun({ status: "complete", stage: "aggregate", finishedAt: 90_001 }),
      "PM 小灰",
      "complete"
    ) as { elements: Array<Record<string, unknown>> };
    const raw = JSON.stringify(card);

    expect(raw).toContain("用时 1 分 30 秒");
    expect(raw).not.toContain("正在汇总结果");
    expect(card.elements.some((element) => element.tag === "action")).toBe(false);
  });

  it("says nothing about duration when the finish time is not known", () => {
    const raw = JSON.stringify(buildProgressCard(makeRun({ finishedAt: null }), "PM 小灰", "complete"));
    expect(raw).not.toContain("用时");
  });
});

describe("the status button", () => {
  let teardown: () => void;

  beforeEach(() => {
    teardown = setupTestDatabase("agentmeld-channel-status-");
    sent.length = 0;
    updated.length = 0;
    connections.length = 0;
    channelsByAgent.clear();
    gate.next = null;
    abortRunMock.mockReset();
    stopChannelProgressForTests();
    setChannelProjectionPaused(false);
    clearPendingQuestionsForTests();
    clearPendingBashForTests();
    clearPendingWritesForTests();
    clearPendingPlansForTests();

    createConversation({
      id: "conv_1", title: "飞书群", mode: "group", agentIds: [AGENT],
      fsWriteApprovalMode: "auto", now: 1
    });
    createChannelConversation({
      id: "cc_1", channel: "feishu", chatId: "oc_1", conversationId: "conv_1", now: 1
    });
    channelsByAgent.set(AGENT, {});
    connections.push({ agentId: AGENT, botName: "PM 小灰" });
    upsertChannelBinding({
      id: "cb_pm", agentId: AGENT, channel: "feishu", appId: "cli_pm", appSecret: "s",
      boundByOpenId: "ou_user", now: 1
    });
  });

  afterEach(() => {
    stopChannelProgressForTests();
    clearPendingQuestionsForTests();
    clearPendingBashForTests();
    clearPendingWritesForTests();
    clearPendingPlansForTests();
    setChannelProjectionPaused(false);
    teardown();
  });

  function seed(overrides: { id?: string; parentRunId?: string | null; status?: AgentRun["status"] } = {}) {
    return createRun({
      id: overrides.id ?? `run_${Math.random().toString(36).slice(2, 8)}`,
      conversationId: "conv_1",
      agentId: AGENT,
      triggerMessageId: null,
      parentRunId: overrides.parentRunId ?? null,
      status: overrides.status ?? "running",
      now: Date.now()
    });
  }

  const tick = () => new Promise((resolve) => setTimeout(resolve, 15));

  it("counts a run's children and what is waiting on a person, and nobody else's", () => {
    const conductor = seed({ id: "run_conductor" });
    seed({ parentRunId: conductor.id, status: "complete" });
    seed({ parentRunId: conductor.id, status: "complete" });
    const running = seed({ parentRunId: conductor.id, status: "running" });
    seed({ parentRunId: conductor.id, status: "failed" });
    const unrelated = seed({ id: "run_unrelated" });
    const question = [{ question: "继续吗？", header: "确认", options: [{ label: "是" }] }];

    // All four sources of "waiting", one each, on the run or a child of it...
    void registerPendingQuestion("conv_1", AGENT, running.id, question);
    void registerPendingBash("conv_1", AGENT, conductor.id, "ls", "/tmp", "看看");
    void registerPendingWrite("conv_1", AGENT, running.id, "a.txt", "/tmp/a.txt", null, "x");
    void registerPendingPlan("conv_1", conductor.id, []);
    // ...and one on a run that is not part of this one, which must not count.
    void registerPendingBash("conv_1", AGENT, unrelated.id, "ls", "/tmp", "别人的");

    const result = collectRunStatus(conductor, conductor.startedAt + 5000);

    expect(result.childTotal).toBe(4);
    expect(result.children).toEqual({ queued: 0, running: 1, complete: 2, failed: 1, aborted: 0 });
    expect(result.waiting).toEqual({ questions: 1, approvals: 3 });
  });

  it("answers a click at once and refreshes the shared card", async () => {
    const run = seed();
    await projectRunStarted(run);
    updated.length = 0;

    const response = handleRunStatusClick({
      runId: run.id,
      chatId: "oc_1",
      now: run.startedAt + 130_000
    });

    // The toast is the answer to the click; it does not wait on the platform.
    expect(response).toMatchObject({ toast: { type: "info" } });
    const content = (response as { toast: { content: string } }).toast.content;
    expect(content).toContain("正在处理");
    expect(content).toContain("已运行 2 分 10 秒");

    await tick();
    // The room's card was rewritten, with the same reading, and is still live.
    expect(updated).toHaveLength(1);
    const raw = JSON.stringify(updated[0].card);
    expect(raw).toContain("已运行 2 分 10 秒");
    expect(raw).toContain("取消运行");
  });

  it("refuses a click that came from another chat", async () => {
    const run = seed();
    await projectRunStarted(run);
    updated.length = 0;

    const response = handleRunStatusClick({ runId: run.id, chatId: "oc_elsewhere" });

    expect(response).toMatchObject({ toast: { type: "error" } });
    await tick();
    expect(updated).toHaveLength(0);
  });

  it("refuses a click when the conversation is not mapped to a chat", () => {
    // Fail closed, like the other card actions: a missing mapping is not a
    // reason to accept the click.
    // A real conversation that is simply not on a channel — the case the check
    // exists for, and one a foreign key would not let me fake with a made-up id.
    createConversation({
      id: "conv_plain", title: "普通会话", mode: "group", agentIds: [AGENT],
      fsWriteApprovalMode: "auto", now: 1
    });
    const run = createRun({
      id: "run_unmapped", conversationId: "conv_plain", agentId: AGENT,
      triggerMessageId: null, parentRunId: null, status: "running", now: Date.now()
    });
    expect(handleRunStatusClick({ runId: run.id, chatId: "oc_1" })).toMatchObject({
      toast: { type: "error" }
    });
  });

  it("says so for a run that is gone", () => {
    expect(handleRunStatusClick({ runId: "run_nope", chatId: "oc_1" })).toMatchObject({
      toast: { type: "info", content: "这次运行已经结束了。" }
    });
  });

  it("answers a click on a finished run with how it ended, and rewrites nothing", async () => {
    const run = seed();
    await projectRunStarted(run);
    updateRunStatus(run.id, "failed", null, Date.now());
    updated.length = 0;

    const response = handleRunStatusClick({ runId: run.id, chatId: "oc_1" });

    expect(response).toMatchObject({ toast: { type: "info", content: "这次运行失败。" } });
    await tick();
    expect(updated).toHaveLength(0);
  });

  it("still answers while outbound is paused, but does not touch the room", async () => {
    const run = seed();
    await projectRunStarted(run);
    updated.length = 0;
    setChannelProjectionPaused(true);

    const response = handleRunStatusClick({ runId: run.id, chatId: "oc_1" });

    expect(response).toMatchObject({ toast: { type: "info" } });
    await tick();
    expect(updated).toHaveLength(0);
  });

  it("answers for a run whose card was never posted, without inventing one", async () => {
    const run = seed();

    const response = handleRunStatusClick({ runId: run.id, chatId: "oc_1" });

    expect(response).toMatchObject({ toast: { type: "info" } });
    await tick();
    expect(updated).toHaveLength(0);
    expect(sent).toHaveLength(0);
  });

  it("lets a refresh that is still on its way land BEFORE the settle, not after", async () => {
    // The race: a status click starts rewriting the card, the run ends, and the
    // settle rewrites it too. If the slower refresh landed last it would put a
    // live-looking card — buttons and all — back over a finished one. Updates to
    // one card are queued, so the settle always follows.
    const run = seed();
    await projectRunStarted(run);
    updated.length = 0;
    let release!: () => void;
    gate.next = new Promise<void>((resolve) => {
      release = resolve;
    });

    handleRunStatusClick({ runId: run.id, chatId: "oc_1", now: run.startedAt + 1000 });
    const settled = settleRunCard(
      { ...run, status: "complete", finishedAt: run.startedAt + 2000 },
      "complete"
    );
    await tick();
    // Neither has landed: the refresh is held open, and the settle is waiting
    // its turn rather than overtaking it.
    expect(updated).toHaveLength(0);

    release();
    await settled;

    expect(updated).toHaveLength(2);
    expect(JSON.stringify(updated[0].card)).toContain("查看状态");
    expect(JSON.stringify(updated[1].card)).toContain("已完成");
    expect(JSON.stringify(updated[1].card)).not.toContain("取消运行");
  });

  it("does nothing for a refresh that arrives after the card was settled", async () => {
    const run = seed();
    await projectRunStarted(run);
    await settleRunCard({ ...run, status: "complete", finishedAt: run.startedAt + 2000 }, "complete");
    updated.length = 0;

    // The row still says "running" here, so the click gets past the terminal
    // check; what stops the rewrite is the card no longer being registered.
    handleRunStatusClick({ runId: run.id, chatId: "oc_1" });
    await tick();

    expect(updated).toHaveLength(0);
  });
});
