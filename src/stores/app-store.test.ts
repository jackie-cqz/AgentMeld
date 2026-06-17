import { beforeEach, describe, expect, it } from "vitest";
import { useAppStore } from "@/stores/app-store";
import type { Message } from "@/shared/types";

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
    connectionStatus: "connecting",
    lastHeartbeatAt: null,
    isBootstrapping: false,
    composerDraft: ""
  });
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
});
