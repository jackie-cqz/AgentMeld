import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setupTestDatabase } from "@/test/test-database";
import {
  buildProgressCard,
  cancelRunFromCard,
  projectRunStarted,
  settleRunCard,
  startChannelProgress,
  stopChannelProgressForTests
} from "@/server/channels/feishu/progress";
import { setChannelProjectionPaused } from "@/server/channels/feishu/projection";
import {
  createChannelConversation,
  createConversation,
  createRun,
  getRun,
  upsertChannelBinding
} from "@/server/repositories";
import type { AgentRun } from "@/shared/types";

const { channelsByAgent, sent, updated, connections, abortRunMock } = vi.hoisted(() => ({
  channelsByAgent: new Map<string, unknown>(),
  sent: [] as Array<{ agentId: string; chatId: string; input: unknown }>,
  updated: [] as Array<{ messageId: string; card: unknown }>,
  connections: [] as Array<{ agentId: string; botName: string | null }>,
  abortRunMock: vi.fn()
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
      actions: Array<{ value: unknown }>;
    };
    expect(action.actions[0].value).toEqual({ kind: "cancel_run", runId: "run_1" });
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
