import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAppStore } from "@/stores/app-store";
import type { AgentRun, Artifact, Message, PendingQuestion } from "@/shared/types";

const conversationId = "conv_123456789abc";
const sampleMessage: Message = {
  id: "msg_123456789abc",
  conversationId,
  role: "user",
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
    const message = { ...sampleMessage, id: "msg_agent", role: "agent" as const, parts: [] };
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
    const message = { ...sampleMessage, id: "msg_deploy", role: "agent" as const, parts: [] };
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
