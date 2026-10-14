import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAppStore } from "@/stores/app-store";
import { mergeSession } from "@/stores/reducers/channel-events";
import type { AgentRun, Artifact, Message, PendingQuestion } from "@/shared/types";

const conversationId = "conv_123456789abc";
const sampleMessage: Message = {
  id: "msg_123456789abc",
  conversationId,
  role: "user", origin: "human",
  agentId: null,
  runId: null,
  parts: [{ type: "text", content: "hello" }],
  status: "complete",
  mentionedAgentIds: [],
  parentMessageId: null,
  createdAt: 1,
  updatedAt: 1
};

beforeEach(() => {
  useAppStore.setState({
    agents: {},
    agentIds: [],
    conversations: {},
    conversationOrder: [],
    messages: {},
    messageIdsByConversation: {},
    runs: {},
    runIdsByConversation: {},
    artifacts: {},
    artifactIdsByConversation: {},
    pendingWrites: {},
    pendingWriteIdsByConversation: {},
    pendingBashCommands: {},
    pendingBashCommandIdsByConversation: {},
    pendingDispatchPlans: {},
    pendingDispatchPlanIdsByConversation: {},
    pendingQuestions: {},
    pendingQuestionIdsByConversation: {},
    dispatchesByRunId: {},
    compactionByConversation: {},
    searchState: {
      isOpen: false,
      query: "",
      status: "idle",
      results: [],
      total: 0,
      mode: "fts",
      error: null
    },
    openFilesByConversation: {},
    openDiffsByConversation: {},
    activeTabByConversation: {},
    channelBindings: {},
    channelBindingSessions: {},
    channelBindingError: null,
    channelBindingsLoaded: false,
    replyTargetByConversation: {},
    pendingAttachmentsByConversation: {},
    fileRevisionByConversation: {},
    highlightedMessageId: null,
    activeConversationId: null,
    activeArtifactId: null,
    sidebarTab: "conversations",
    rightPanelOpen: true,
    artifactPanelWidth: 640,
    connectionStatus: "connecting",
    lastHeartbeatAt: null,
    isBootstrapping: false,
    composerDraftByConversation: {}
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("app-store normalized message events", () => {
  it("upserts repeated message.added events without duplicating ids", () => {
    const { applyEvent } = useAppStore.getState();
    applyEvent({ type: "message.added", conversationId, timestamp: 1, message: sampleMessage });
    applyEvent({
      type: "message.added",
      conversationId,
      timestamp: 2,
      message: { ...sampleMessage, updatedAt: 2 }
    });

    expect(useAppStore.getState().messages[sampleMessage.id]?.updatedAt).toBe(2);
    expect(useAppStore.getState().messageIdsByConversation[conversationId]).toEqual([sampleMessage.id]);
  });

  it("streams structured parts and ignores part.end", () => {
    const { applyEvent } = useAppStore.getState();
    applyEvent({
      type: "message.start",
      conversationId,
      timestamp: 1,
      messageId: "msg_agent123456",
      agentId: "ag_123456789abc",
      runId: "run_123456789abc"
    });
    applyEvent({
      type: "part.start",
      conversationId,
      timestamp: 2,
      messageId: "msg_agent123456",
      partIndex: 0,
      part: { type: "text", content: "" }
    });
    applyEvent({
      type: "part.delta",
      conversationId,
      timestamp: 3,
      messageId: "msg_agent123456",
      partIndex: 0,
      delta: { type: "text.append", text: "hello" }
    });
    applyEvent({
      type: "part.end",
      conversationId,
      timestamp: 4,
      messageId: "msg_agent123456",
      partIndex: 0
    });

    expect(useAppStore.getState().messages.msg_agent123456?.parts[0]).toEqual({
      type: "text",
      content: "hello"
    });
  });

  it("removes messages and artifacts idempotently", () => {
    const artifact = createArtifact();
    const { applyEvent } = useAppStore.getState();
    applyEvent({ type: "message.added", conversationId, timestamp: 1, message: sampleMessage });
    applyEvent({ type: "artifact.create", conversationId, timestamp: 1, artifact });

    const event = {
      type: "message.removed" as const,
      conversationId,
      timestamp: 2,
      messageIds: [sampleMessage.id],
      artifactIds: [artifact.id]
    };
    applyEvent(event);
    applyEvent(event);

    expect(useAppStore.getState().messages[sampleMessage.id]).toBeUndefined();
    expect(useAppStore.getState().artifacts[artifact.id]).toBeUndefined();
    expect(useAppStore.getState().messageIdsByConversation[conversationId]).toEqual([]);
    expect(useAppStore.getState().artifactIdsByConversation[conversationId]).toEqual([]);
  });

  it("keeps the optimistic user message before an agent reply when SSE wins the race", async () => {
    const realUserMessage: Message = {
      ...sampleMessage,
      id: "msg_real_user",
      parts: [{ type: "text", content: "晚安好" }],
      createdAt: 100,
      updatedAt: 100
    };
    let resolveRequest!: (response: Response) => void;
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((resolve) => {
      resolveRequest = resolve;
    })));

    const sendPromise = useAppStore.getState().sendMessage(conversationId, "晚安好");
    const optimisticId = useAppStore.getState().messageIdsByConversation[conversationId]?.[0];
    expect(optimisticId).toMatch(/^local-/);

    const { applyEvent } = useAppStore.getState();
    applyEvent({
      type: "message.added",
      conversationId,
      timestamp: 100,
      message: realUserMessage
    });
    applyEvent({
      type: "message.start",
      conversationId,
      timestamp: 101,
      messageId: "msg_agent_reply",
      agentId: "ag_conductor",
      runId: "run_reply"
    });

    resolveRequest(new Response(JSON.stringify({ message: realUserMessage }), {
      status: 202,
      headers: { "Content-Type": "application/json" }
    }));
    await sendPromise;

    expect(useAppStore.getState().messageIdsByConversation[conversationId]).toEqual([
      realUserMessage.id,
      "msg_agent_reply"
    ]);
  });
});

describe("app-store search state", () => {
  it("loads search results and jumps to the selected message", async () => {
    const hit = {
      messageId: "msg_search_hit",
      conversationId,
      conversationTitle: "Search conversation",
      role: "user" as const,
      agentId: null,
      agentName: null,
      agentAvatar: null,
      createdAt: 1,
      snippetHtml: "<mark>hello</mark>"
    };
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      ok: true,
      data: { hits: [hit], total: 1, mode: "fts", tookMs: 1 }
    }), { status: 200, headers: { "Content-Type": "application/json" } })));

    useAppStore.getState().setSearchQuery("hello");
    await useAppStore.getState().runSearch();

    expect(useAppStore.getState().searchState.results).toEqual([hit]);
    expect(useAppStore.getState().searchState.total).toBe(1);

    vi.useFakeTimers();
    useAppStore.getState().jumpToSearchHit(hit);
    expect(useAppStore.getState().activeConversationId).toBe(conversationId);
    expect(useAppStore.getState().highlightedMessageId).toBe(hit.messageId);
    expect(useAppStore.getState().searchState.isOpen).toBe(false);
    vi.runAllTimers();
    expect(useAppStore.getState().highlightedMessageId).toBeNull();
    vi.useRealTimers();
  });
});

describe("app-store tool, artifact, and run events", () => {
  it("upserts tool results by call id", () => {
    const message = { ...sampleMessage, id: "msg_agent", role: "agent" as const, origin: "bot" as const, parts: [] };
    const { applyEvent } = useAppStore.getState();
    applyEvent({ type: "message.added", conversationId, timestamp: 1, message });
    applyEvent({
      type: "tool.call",
      conversationId,
      timestamp: 2,
      messageId: message.id,
      callId: "call_1",
      toolName: "bash",
      args: { command: "pnpm test" }
    });
    applyEvent({
      type: "tool.result",
      conversationId,
      timestamp: 3,
      messageId: message.id,
      callId: "call_1",
      result: "first"
    });
    applyEvent({
      type: "tool.result",
      conversationId,
      timestamp: 4,
      messageId: message.id,
      callId: "call_1",
      result: "updated"
    });

    const parts = useAppStore.getState().messages[message.id]?.parts ?? [];
    expect(parts.filter((part) => part.type === "tool_use")).toHaveLength(1);
    expect(parts.filter((part) => part.type === "tool_result")).toHaveLength(1);
    expect(parts.find((part) => part.type === "tool_result")).toMatchObject({ result: "updated" });
  });

  it("creates and updates artifacts through the normalized map", () => {
    const artifact = createArtifact();
    const { applyEvent } = useAppStore.getState();
    applyEvent({ type: "artifact.create", conversationId, timestamp: 1, artifact });
    applyEvent({
      type: "artifact.update",
      conversationId,
      timestamp: 2,
      artifactId: artifact.id,
      patch: { content: "# Updated" }
    });

    expect(useAppStore.getState().artifactIdsByConversation[conversationId]).toEqual([artifact.id]);
    expect(useAppStore.getState().artifacts[artifact.id]?.content).toMatchObject({ content: "# Updated" });
  });

  it("replaces deploy status for the same deployment id", () => {
    const message = { ...sampleMessage, id: "msg_deploy", role: "agent" as const, origin: "bot" as const, parts: [] };
    const { applyEvent } = useAppStore.getState();
    applyEvent({ type: "message.added", conversationId, timestamp: 1, message });
    const deployment = {
      id: "dep_1",
      artifactId: "art_1",
      title: "Preview",
      version: 1,
      previewPath: "/deployments/dep_1",
      status: "ready" as const,
      createdAt: 1
    };
    applyEvent({ type: "deploy.status", conversationId, timestamp: 2, messageId: message.id, deployment });
    applyEvent({
      type: "deploy.status",
      conversationId,
      timestamp: 3,
      messageId: message.id,
      deployment: { ...deployment, previewPath: "/deployments/dep_1/latest" }
    });

    const deployParts = useAppStore.getState().messages[message.id]?.parts.filter(
      (part) => part.type === "deploy_status"
    );
    expect(deployParts).toHaveLength(1);
    expect(deployParts?.[0]).toMatchObject({
      deployment: { previewPath: "/deployments/dep_1/latest" }
    });
  });

  it("marks failed run messages terminal and fills unmatched tool results", () => {
    const run = createRun();
    const message: Message = {
      ...sampleMessage,
      id: "msg_agent_failed",
      role: "agent",
      origin: "bot",
      agentId: run.agentId,
      runId: run.id,
      status: "streaming",
      parts: [{ type: "tool_use", callId: "call_1", toolName: "bash", args: {} }]
    };
    const { applyEvent } = useAppStore.getState();
    applyEvent({ type: "message.added", conversationId, timestamp: 1, message });
    applyEvent({
      type: "run.start",
      conversationId,
      timestamp: 1,
      runId: run.id,
      agentId: run.agentId,
      triggerMessageId: run.triggerMessageId
    });
    applyEvent({
      type: "run.end",
      conversationId,
      timestamp: 2,
      runId: run.id,
      status: "failed",
      error: "boom"
    });

    const updated = useAppStore.getState().messages[message.id];
    expect(updated?.status).toBe("error");
    expect(updated?.parts.some(
      (part) => part.type === "tool_result" && part.callId === "call_1" && part.isError
    )).toBe(true);
  });
});

describe("app-store workflow events", () => {
  it("tracks pending queues and removes resolved entries", () => {
    const { applyEvent } = useAppStore.getState();
    applyEvent({
      type: "fs_write.pending",
      conversationId,
      timestamp: 1,
      pendingWrite: {
        id: "pw_1",
        conversationId,
        agentId: "ag_1",
        runId: "run_1",
        path: "README.md",
        absolutePath: "C:/workspace/README.md",
        oldContent: null,
        newContent: "hello",
        createdAt: 1
      }
    });
    applyEvent({
      type: "bash_command.pending",
      conversationId,
      timestamp: 1,
      pendingCommand: {
        id: "pb_1",
        conversationId,
        agentId: "ag_1",
        runId: "run_1",
        command: "pnpm test",
        cwd: "C:/workspace",
        reason: "verify",
        createdAt: 1
      }
    });

    expect(useAppStore.getState().pendingWriteIdsByConversation[conversationId]).toEqual(["pw_1"]);
    expect(useAppStore.getState().pendingBashCommandIdsByConversation[conversationId]).toEqual(["pb_1"]);

    applyEvent({ type: "fs_write.resolved", conversationId, timestamp: 2, pendingId: "pw_1", applied: true });
    applyEvent({
      type: "bash_command.resolved",
      conversationId,
      timestamp: 2,
      pendingId: "pb_1",
      approved: false
    });
    expect(useAppStore.getState().pendingWrites.pw_1).toBeUndefined();
    expect(useAppStore.getState().pendingBashCommands.pb_1).toBeUndefined();
  });

  it("tracks pending questions from ask_user events", () => {
    const pendingQuestion: PendingQuestion = {
      id: "pq_123",
      conversationId,
      agentId: "ag_123",
      runId: "run_123",
      questions: [{ header: "Choice", question: "Pick one", options: [{ label: "A" }] }],
      createdAt: 1
    };
    const { applyEvent } = useAppStore.getState();
    applyEvent({ type: "ask_user.pending", conversationId, timestamp: 1, pendingQuestion });
    expect(useAppStore.getState().pendingQuestionIdsByConversation[conversationId]).toEqual(["pq_123"]);

    applyEvent({
      type: "ask_user.answered",
      conversationId,
      timestamp: 2,
      pendingId: "pq_123",
      answers: { "Pick one": "A" }
    });
    expect(useAppStore.getState().pendingQuestions.pq_123).toBeUndefined();
  });

  it("tracks dispatch review and execution by parent run id", () => {
    const { applyEvent } = useAppStore.getState();
    const plan = [{ id: "t1", agentId: "ag_123", task: "Build UI", dependsOn: [] }];
    applyEvent({
      type: "dispatch.plan.pending",
      conversationId,
      timestamp: 1,
      pendingPlan: { id: "dp_1", conversationId, runId: "run_parent", plan, createdAt: 1 }
    });
    applyEvent({
      type: "dispatch.plan.resolved",
      conversationId,
      timestamp: 2,
      pendingId: "dp_1",
      runId: "run_parent",
      approved: true
    });
    applyEvent({
      type: "dispatch.start",
      conversationId,
      timestamp: 3,
      parentRunId: "run_parent",
      childRunId: "run_child",
      taskId: "t1",
      agentId: "ag_123"
    });
    applyEvent({
      type: "dispatch.end",
      conversationId,
      timestamp: 4,
      parentRunId: "run_parent",
      childRunId: "run_child",
      taskId: "t1",
      status: "complete"
    });

    const dispatch = useAppStore.getState().dispatchesByRunId.run_parent;
    expect(dispatch?.reviewStatus).toBe("approved");
    expect(dispatch?.taskStatus.t1).toBe("complete");
    expect(dispatch?.childRunIds.t1).toBe("run_child");
  });

  it("tracks compaction progress by conversation", () => {
    const { applyEvent } = useAppStore.getState();
    applyEvent({ type: "compaction.start", conversationId, timestamp: 1, sourceMessageCount: 8 });
    applyEvent({
      type: "compaction.progress",
      conversationId,
      timestamp: 2,
      stage: "summarizing",
      detail: "Summarizing"
    });
    applyEvent({
      type: "compaction.end",
      conversationId,
      timestamp: 3,
      sourceMessageCount: 8,
      coveredUntilMessageId: sampleMessage.id,
      summary: "Summary",
      tokenEstimate: 120
    });

    expect(useAppStore.getState().compactionByConversation[conversationId]).toMatchObject({
      status: "complete",
      summary: "Summary",
      tokenEstimate: 120
    });
  });
});

describe("app-store bootstrap and UI state", () => {
  it("normalizes bootstrap payload and all pending queues", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        agents: [],
        conversations: [{
          id: conversationId,
          title: "Test",
          mode: "single",
          agentIds: [],
          fsWriteApprovalMode: "auto",
          pinnedMessageIds: [],
          pinnedAt: null,
          archived: false,
          createdAt: 1,
          updatedAt: 1
        }],
        messagesByConversation: { [conversationId]: [sampleMessage] },
        runsByConversation: { [conversationId]: [createRun()] },
        artifactsByConversation: { [conversationId]: [createArtifact()] },
        pendingWrites: [],
        pendingBashCommands: [],
        pendingDispatchPlans: [],
        pendingQuestions: [{
          id: "pq_boot",
          conversationId,
          agentId: "ag_1",
          runId: "run_1",
          questions: [],
          createdAt: 1
        }]
      })
    }));

    await useAppStore.getState().loadBootstrap();

    expect(useAppStore.getState().messageIdsByConversation[conversationId]).toEqual([sampleMessage.id]);
    expect(useAppStore.getState().runIdsByConversation[conversationId]).toEqual(["run_123456789abc"]);
    expect(useAppStore.getState().artifactIdsByConversation[conversationId]).toEqual(["art_123456789abc"]);
    expect(useAppStore.getState().pendingQuestionIdsByConversation[conversationId]).toEqual(["pq_boot"]);
  });

  it("opens the right panel when an artifact is selected", () => {
    useAppStore.setState({ rightPanelOpen: false });
    useAppStore.getState().setActiveArtifact("art_123456789abc");
    expect(useAppStore.getState().activeArtifactId).toBe("art_123456789abc");
    expect(useAppStore.getState().rightPanelOpen).toBe(true);
  });

  it("keeps composer state and tabs isolated by conversation", () => {
    const secondConversationId = "conv_second";
    useAppStore.getState().setComposerDraft(conversationId, "first");
    useAppStore.getState().setComposerDraft(secondConversationId, "second");
    useAppStore.getState().setReplyTarget(conversationId, sampleMessage.id);
    useAppStore.getState().openConversationFile(conversationId, "src/app.ts");
    useAppStore.getState().openPendingWriteDiff(conversationId, "pw_1");

    expect(useAppStore.getState().composerDraftByConversation).toMatchObject({
      [conversationId]: "first",
      [secondConversationId]: "second"
    });
    expect(useAppStore.getState().replyTargetByConversation[conversationId]).toBe(sampleMessage.id);
    expect(useAppStore.getState().activeTabByConversation[conversationId]).toBe("diff:pw_1");

    useAppStore.getState().closeConversationTab(conversationId, "diff:pw_1");
    expect(useAppStore.getState().activeTabByConversation[conversationId]).toBe("file:src/app.ts");
  });
});

describe("non-conversation events", () => {
  it("does not create conversation buckets for an event with an empty conversation id", () => {
    // Channel-binding events are not conversation-scoped. Bucketing "" would
    // leave seven permanent empty arrays for a conversation that cannot exist.
    useAppStore.getState().applyEvent({
      type: "channel.binding.updated",
      conversationId: "",
      timestamp: 1,
      sessionId: "cbs_test",
      agentId: "ag_mock_builder",
      status: "succeeded",
      appId: "cli_test"
    });

    const state = useAppStore.getState();
    expect(state.messageIdsByConversation[""]).toBeUndefined();
    expect(state.runIdsByConversation[""]).toBeUndefined();
    expect(state.artifactIdsByConversation[""]).toBeUndefined();
    expect(state.pendingWriteIdsByConversation[""]).toBeUndefined();
    expect(state.pendingBashCommandIdsByConversation[""]).toBeUndefined();
    expect(state.pendingDispatchPlanIdsByConversation[""]).toBeUndefined();
    expect(state.pendingQuestionIdsByConversation[""]).toBeUndefined();
  });
});

describe("channel binding state", () => {
  it("upserts a session from a stream event", () => {
    useAppStore.getState().applyEvent({
      type: "channel.binding.updated",
      conversationId: "",
      timestamp: 1,
      sessionId: "cbs_1",
      agentId: "ag_1",
      status: "awaiting_scan"
    });

    const session = useAppStore.getState().channelBindingSessions["cbs_1"];
    expect(session?.agentId).toBe("ag_1");
    expect(session?.status).toBe("awaiting_scan");
  });

  it("drops the launcher URL once the attempt settles", () => {
    // The event never carries the URL, so a settled session must lose the one
    // the start response supplied — otherwise the UI keeps showing a spent QR.
    useAppStore.setState((state) => {
      state.channelBindingSessions["cbs_1"] = {
        id: "cbs_1",
        agentId: "ag_1",
        status: "awaiting_scan",
        expiresAt: 9999,
        qrUrl: "https://example.test/launcher"
      };
    });

    useAppStore.getState().applyEvent({
      type: "channel.binding.updated",
      conversationId: "",
      timestamp: 2,
      sessionId: "cbs_1",
      agentId: "ag_1",
      status: "succeeded",
      bindingId: "cb_1",
      appId: "cli_1"
    });

    const session = useAppStore.getState().channelBindingSessions["cbs_1"];
    expect(session?.status).toBe("succeeded");
    expect(session?.qrUrl).toBeUndefined();
    // The expiry is not carried by the event, so the known one is kept.
    expect(session?.expiresAt).toBe(9999);
  });

  it("keeps the launcher URL while the attempt is still waiting", () => {
    useAppStore.setState((state) => {
      state.channelBindingSessions["cbs_1"] = {
        id: "cbs_1",
        agentId: "ag_1",
        status: "awaiting_scan",
        expiresAt: 9999,
        qrUrl: "https://example.test/launcher"
      };
    });

    useAppStore.getState().applyEvent({
      type: "channel.binding.updated",
      conversationId: "",
      timestamp: 2,
      sessionId: "cbs_1",
      agentId: "ag_1",
      status: "awaiting_scan"
    });

    expect(useAppStore.getState().channelBindingSessions["cbs_1"]?.qrUrl).toBe(
      "https://example.test/launcher"
    );
  });

  it("carries the failure message through to the session", () => {
    useAppStore.getState().applyEvent({
      type: "channel.binding.updated",
      conversationId: "",
      timestamp: 3,
      sessionId: "cbs_2",
      agentId: "ag_1",
      status: "failed",
      error: "access_denied"
    });

    expect(useAppStore.getState().channelBindingSessions["cbs_2"]?.error).toBe("access_denied");
  });

  it("records the app id and row id a success event carries", () => {
    useAppStore.getState().applyEvent({
      type: "channel.binding.updated",
      conversationId: "",
      timestamp: 4,
      sessionId: "cbs_3",
      agentId: "ag_1",
      status: "succeeded",
      bindingId: "cb_3",
      appId: "cli_3"
    });

    const session = useAppStore.getState().channelBindingSessions["cbs_3"];
    expect(session?.appId).toBe("cli_3");
    expect(session?.bindingId).toBe("cb_3");
  });
});

describe("channel binding actions", () => {
  const originalFetch = globalThis.fetch;
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("keeps the failure message and does not refresh when the start fails for another reason", async () => {
    // The refresh used to run unconditionally and its success path cleared the
    // error, so a 502 reached the user as no message at all.
    const urls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      urls.push(String(input));
      return json(502, { error: "upstream exploded", sessionId: "cbs_9" });
    }) as typeof fetch;

    await expect(useAppStore.getState().startFeishuBinding("ag_1")).rejects.toThrow();

    const state = useAppStore.getState();
    expect(state.channelBindingError).toContain("upstream exploded");
    expect(urls).toHaveLength(1);
  });

  it("refreshes on a conflict so the waiting QR code becomes visible", async () => {
    let call = 0;
    globalThis.fetch = (async () => {
      call += 1;
      if (call === 1) return json(409, { error: "already in progress", sessionId: "cbs_9" });
      return json(200, {
        data: {
          bindings: [],
          sessions: [
            {
              id: "cbs_9",
              agentId: "ag_1",
              status: "awaiting_scan",
              expiresAt: 5000,
              qrUrl: "https://open.feishu.cn/page/launcher?user_code=WAITING"
            }
          ]
        }
      });
    }) as typeof fetch;

    await expect(useAppStore.getState().startFeishuBinding("ag_1")).rejects.toThrow();

    const state = useAppStore.getState();
    // The refresh reveals the attempt that is already waiting — including its
    // URL, which is the whole point: without it the dialog has no QR to show.
    expect(state.channelBindingSessions["cbs_9"]?.qrUrl).toContain("user_code=WAITING");
    // …and the conflict is still surfaced rather than being cleared by it.
    expect(state.channelBindingError).toContain("already in progress");
  });

  it("loads bindings and sessions and clears the previous error", async () => {
    useAppStore.setState((state) => {
      state.channelBindingError = "stale";
    });
    globalThis.fetch = (async () =>
      json(200, {
        data: {
          bindings: [
            {
              id: "cb_1",
              agentId: "ag_1",
              channel: "feishu",
              appId: "cli_1",
              tenantBrand: "feishu",
              botOpenId: null,
              boundByOpenId: null,
              chatId: null,
              conversationId: null,
              createdAt: 1,
              updatedAt: 1
            }
          ],
          sessions: []
        }
      })) as typeof fetch;

    await useAppStore.getState().loadChannelBindings();

    const state = useAppStore.getState();
    expect(state.channelBindings["ag_1"]?.appId).toBe("cli_1");
    expect(state.channelBindingError).toBeNull();
    expect(state.channelBindingsLoaded).toBe(true);
  });

  it("unbinds using the row id carried by a success event, without a prior load", async () => {
    // The button used to do nothing at all when the local map was stale: no
    // request, no error, no feedback.
    useAppStore.getState().applyEvent({
      type: "channel.binding.updated",
      conversationId: "",
      timestamp: 5,
      sessionId: "cbs_5",
      agentId: "ag_1",
      status: "succeeded",
      bindingId: "cb_5",
      appId: "cli_5"
    });

    const urls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      urls.push(String(input));
      return json(200, { data: { removed: "cb_5", appLeftBehind: "cli_5" } });
    }) as typeof fetch;

    await useAppStore.getState().unbindFeishu("ag_1");

    expect(urls[0]).toContain("/api/channels/feishu/bindings/cb_5");
    // The binding is gone, so nothing should still render that agent as bound.
    expect(useAppStore.getState().channelBindingSessions["cbs_5"]).toBeUndefined();
  });

  it("keeps the same agent's live attempt when unbinding, and drops its finished one", async () => {
    useAppStore.setState((state) => {
      state.channelBindings["ag_1"] = {
        id: "cb_1", agentId: "ag_1", channel: "feishu", appId: "cli_1",
        tenantBrand: null, botOpenId: null, boundByOpenId: null,
        chatId: null, conversationId: null, createdAt: 1, updatedAt: 1
      };
      // Both belong to the agent being unbound, so a blanket delete of that
      // agent's sessions would take the live attempt with it.
      state.channelBindingSessions["cbs_live"] = sessionFor("ag_1", "awaiting_scan");
      state.channelBindingSessions["cbs_done"] = sessionFor("ag_1", "succeeded");
    });
    globalThis.fetch = (async () => json(200, { data: { removed: "cb_1", appLeftBehind: "cli_1" } })) as typeof fetch;

    await useAppStore.getState().unbindFeishu("ag_1");

    const state = useAppStore.getState();
    // The terminal session described a binding that no longer exists…
    expect(state.channelBindingSessions["cbs_done"]).toBeUndefined();
    // …but a live attempt must survive, or it becomes invisible and
    // uncancellable from this client.
    expect(state.channelBindingSessions["cbs_live"]).toBeDefined();
  });

  it("deletes the row a success event named, not a stale local row", async () => {
    useAppStore.setState((state) => {
      state.channelBindings["ag_1"] = {
        id: "cb_old", agentId: "ag_1", channel: "feishu", appId: "cli_old",
        tenantBrand: null, botOpenId: null, boundByOpenId: null,
        chatId: null, conversationId: null, createdAt: 1, updatedAt: 1
      };
      state.channelBindingSessions["cbs_new"] = {
        id: "cbs_new", agentId: "ag_1", status: "succeeded", expiresAt: 10, bindingId: "cb_new"
      };
    });

    const urls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      urls.push(String(input));
      return json(200, { data: { removed: "cb_new", appLeftBehind: "cli_new" } });
    }) as typeof fetch;

    await useAppStore.getState().unbindFeishu("ag_1");

    // The stale row would delete a binding that is already gone and leave the
    // current one in place.
    expect(urls[0]).toContain("/api/channels/feishu/bindings/cb_new");
  });

  it("merges a list snapshot into the sessions already held", async () => {
    // The pure merge is tested directly, but the wiring is what decides whether
    // it is used at all — replacing it with a blind copy must fail something.
    useAppStore.setState((state) => {
      state.channelBindingSessions["cbs_1"] = {
        id: "cbs_1", agentId: "ag_1", status: "succeeded", expiresAt: 10, bindingId: "cb_1"
      };
      state.channelBindingSessions["cbs_2"] = {
        id: "cbs_2", agentId: "ag_2", status: "awaiting_scan", expiresAt: 10,
        qrUrl: "https://open.feishu.cn/page/launcher?user_code=KEEP"
      };
    });
    globalThis.fetch = (async () =>
      json(200, {
        data: {
          bindings: [],
          sessions: [
            // A snapshot taken before cbs_1 finished.
            { id: "cbs_1", agentId: "ag_1", status: "awaiting_scan", expiresAt: 20 },
            // …and one for cbs_2 that carries no URL.
            { id: "cbs_2", agentId: "ag_2", status: "awaiting_scan", expiresAt: 20 }
          ]
        }
      })) as typeof fetch;

    await useAppStore.getState().loadChannelBindings();

    const state = useAppStore.getState();
    expect(state.channelBindingSessions["cbs_1"]?.status).toBe("succeeded");
    expect(state.channelBindingSessions["cbs_2"]?.qrUrl).toContain("user_code=KEEP");
  });

  it("does not clear a real error when a passive refresh succeeds", async () => {
    // The refetch effect runs mid-flow; without this flag it erased a message
    // from an action that had just failed.
    useAppStore.setState((state) => {
      state.channelBindingError = "解绑失败：404";
    });
    globalThis.fetch = (async () => json(200, { data: { bindings: [], sessions: [] } })) as typeof fetch;

    await useAppStore.getState().loadChannelBindings({ preserveError: true });

    expect(useAppStore.getState().channelBindingError).toBe("解绑失败：404");
    // An explicit load is still allowed to clear it.
    await useAppStore.getState().loadChannelBindings();
    expect(useAppStore.getState().channelBindingError).toBeNull();
  });
});

describe("channel session merging", () => {
  it("does not let a pre-success snapshot undo a terminal status", () => {
    // The list and the event stream race; a snapshot taken before the attempt
    // finished used to send a succeeded row back to "waiting to scan".
    const merged = mergeSession(
      { id: "cbs_1", agentId: "ag_1", status: "succeeded", expiresAt: 10, bindingId: "cb_1" },
      { id: "cbs_1", agentId: "ag_1", status: "awaiting_scan", expiresAt: 20 }
    );
    expect(merged.status).toBe("succeeded");
    expect(merged.bindingId).toBe("cb_1");
  });

  it("does not drop a launcher URL the client already holds", () => {
    const merged = mergeSession(
      { id: "cbs_1", agentId: "ag_1", status: "awaiting_scan", expiresAt: 10, qrUrl: "https://x/y" },
      { id: "cbs_1", agentId: "ag_1", status: "awaiting_scan", expiresAt: 20 }
    );
    expect(merged.qrUrl).toBe("https://x/y");
    expect(merged.expiresAt).toBe(20);
  });

  it("lets a genuinely terminal snapshot win over an older live one", () => {
    const merged = mergeSession(
      { id: "cbs_1", agentId: "ag_1", status: "awaiting_scan", expiresAt: 10, qrUrl: "https://x/y" },
      { id: "cbs_1", agentId: "ag_1", status: "failed", expiresAt: 10, error: "expired" }
    );
    expect(merged.status).toBe("failed");
    expect(merged.error).toBe("expired");
  });

  it("keeps a known expiry when the snapshot does not report one", () => {
    const merged = mergeSession(
      { id: "cbs_1", agentId: "ag_1", status: "awaiting_scan", expiresAt: 500 },
      { id: "cbs_1", agentId: "ag_1", status: "awaiting_scan", expiresAt: 0 }
    );
    expect(merged.expiresAt).toBe(500);
  });
});

function sessionFor(agentId: string, status: "awaiting_scan" | "succeeded") {
  return { id: `cbs_${agentId}_${status}`, agentId, status, expiresAt: 1000 };
}

function createArtifact(): Artifact {
  return {
    id: "art_123456789abc",
    conversationId,
    createdByAgentId: "ag_123456789abc",
    type: "document",
    title: "Spec",
    content: { type: "document", content: "# Spec" },
    version: 1,
    parentArtifactId: null,
    createdAt: 1,
    updatedAt: 1
  };
}

function createRun(): AgentRun {
  return {
    id: "run_123456789abc",
    conversationId,
    agentId: "ag_123456789abc",
    triggerMessageId: sampleMessage.id,
    parentRunId: null,
    status: "running",
    stage: null,
    error: null,
    errorCategory: null,
    retryable: false,
    usage: null,
    interrupted: false,
    startedAt: 1,
    finishedAt: null,
    createdAt: 1,
    updatedAt: 1
  };
}
