import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAppStore } from "@/stores/app-store";
import type { Artifact, Message } from "@/shared/types";

const sampleMessage: Message = {
  id: "msg_123456789abc",
  conversationId: "conv_123456789abc",
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
    conversations: {},
    conversationOrder: [],
    messagesByConversation: {},
    runsByConversation: {},
    artifactsByConversation: {},
    pendingWrites: {},
    pendingBashCommands: {},
    pendingDispatchPlans: {},
    activeConversationId: null,
    activeArtifactId: null,
    sidebarTab: "conversations",
    rightPanelOpen: true,
    artifactPanelWidth: 640,
    connectionStatus: "connecting",
    lastHeartbeatAt: null,
    isBootstrapping: false,
    composerDraft: ""
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("app-store StreamEvent reducer", () => {
  it("upserts repeated message.added events by id", () => {
    const { applyEvent } = useAppStore.getState();

    applyEvent({
      type: "message.added",
      conversationId: sampleMessage.conversationId,
      timestamp: 1,
      message: sampleMessage
    });
    applyEvent({
      type: "message.added",
      conversationId: sampleMessage.conversationId,
      timestamp: 2,
      message: { ...sampleMessage, updatedAt: 2 }
    });

    const messages = useAppStore.getState().messagesByConversation[sampleMessage.conversationId];
    expect(messages).toHaveLength(1);
    expect(messages[0]?.updatedAt).toBe(2);
  });

  it("removes messages idempotently", () => {
    const { applyEvent } = useAppStore.getState();
    applyEvent({
      type: "message.added",
      conversationId: sampleMessage.conversationId,
      timestamp: 1,
      message: sampleMessage
    });

    applyEvent({
      type: "message.removed",
      conversationId: sampleMessage.conversationId,
      timestamp: 2,
      messageIds: [sampleMessage.id],
      artifactIds: []
    });
    applyEvent({
      type: "message.removed",
      conversationId: sampleMessage.conversationId,
      timestamp: 3,
      messageIds: [sampleMessage.id],
      artifactIds: []
    });

    expect(useAppStore.getState().messagesByConversation[sampleMessage.conversationId]).toEqual([]);
  });

  it("applies structured part delta events", () => {
    const { applyEvent } = useAppStore.getState();
    applyEvent({
      type: "message.start",
      conversationId: sampleMessage.conversationId,
      timestamp: 1,
      messageId: "msg_agent123456",
      agentId: "ag_123456789abc",
      runId: "run_123456789abc"
    });
    applyEvent({
      type: "part.start",
      conversationId: sampleMessage.conversationId,
      timestamp: 2,
      messageId: "msg_agent123456",
      partIndex: 0,
      part: { type: "text", content: "" }
    });
    applyEvent({
      type: "part.delta",
      conversationId: sampleMessage.conversationId,
      timestamp: 3,
      messageId: "msg_agent123456",
      partIndex: 0,
      delta: { type: "text.append", text: "hello" }
    });

    const message = useAppStore.getState().messagesByConversation[sampleMessage.conversationId]?.[0];
    expect(message?.parts[0]).toEqual({ type: "text", content: "hello" });
  });

  it("closes the right panel when the active artifact is removed", () => {
    const artifact: Artifact = {
      id: "art_123456789abc",
      conversationId: sampleMessage.conversationId,
      createdByAgentId: "ag_123456789abc",
      type: "document",
      title: "Spec",
      content: { type: "document", content: "# Spec" },
      version: 1,
      parentArtifactId: null,
      createdAt: 1,
      updatedAt: 1
    };

    useAppStore.setState({
      artifactsByConversation: { [sampleMessage.conversationId]: [artifact] },
      activeArtifactId: artifact.id,
      rightPanelOpen: true
    });

    useAppStore.getState().applyEvent({
      type: "message.removed",
      conversationId: sampleMessage.conversationId,
      timestamp: 2,
      messageIds: [],
      artifactIds: [artifact.id]
    });

    expect(useAppStore.getState().activeArtifactId).toBeNull();
    expect(useAppStore.getState().rightPanelOpen).toBe(false);
  });
});

describe("app-store P6 UI state", () => {
  it("opens the right panel when an artifact is selected", () => {
    useAppStore.setState({ rightPanelOpen: false });

    useAppStore.getState().setActiveArtifact("art_123456789abc");

    expect(useAppStore.getState().activeArtifactId).toBe("art_123456789abc");
    expect(useAppStore.getState().rightPanelOpen).toBe(true);
  });

  it("loads pending queues from bootstrap", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          agents: [],
          conversations: [],
          messagesByConversation: {},
          runsByConversation: {},
          artifactsByConversation: {},
          pendingWrites: [
            {
              id: "pw_123",
              conversationId: sampleMessage.conversationId,
              agentId: "ag_123",
              runId: "run_123",
              path: "README.md",
              absolutePath: "C:/work/Agent-Conference/README.md",
              oldContent: null,
              newContent: "hello",
              createdAt: 1
            }
          ],
          pendingBashCommands: [
            {
              id: "pb_123",
              conversationId: sampleMessage.conversationId,
              agentId: "ag_123",
              runId: "run_123",
              command: "pnpm test",
              cwd: "C:/work/Agent-Conference",
              reason: "verify",
              createdAt: 1
            }
          ],
          pendingDispatchPlans: [
            {
              id: "dp_123",
              conversationId: sampleMessage.conversationId,
              runId: "run_123",
              plan: [{ id: "t1", agentId: "ag_123", task: "Build UI", dependsOn: [] }],
              createdAt: 1
            }
          ]
        })
      })
    );

    await useAppStore.getState().loadBootstrap();

    expect(useAppStore.getState().pendingWrites.pw_123?.path).toBe("README.md");
    expect(useAppStore.getState().pendingBashCommands.pb_123?.command).toBe("pnpm test");
    expect(useAppStore.getState().pendingDispatchPlans.dp_123?.plan[0]?.id).toBe("t1");
  });
});
