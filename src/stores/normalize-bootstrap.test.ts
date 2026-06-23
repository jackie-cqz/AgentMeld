import { describe, expect, it } from "vitest";
import { normalizeBootstrap } from "@/stores/normalize-bootstrap";
import type { BootstrapPayload } from "@/stores/store-types";

describe("normalizeBootstrap", () => {
  it("sorts conversations and entity buckets deterministically", () => {
    const payload = createPayload();
    const state = normalizeBootstrap(payload);

    expect(state.conversationOrder).toEqual(["conv_new", "conv_old"]);
    expect(state.messageIdsByConversation.conv_new).toEqual(["msg_early", "msg_late"]);
    expect(state.runIdsByConversation.conv_new).toEqual([]);
    expect(state.artifactIdsByConversation.conv_old).toEqual([]);
  });

  it("creates empty buckets for missing conversation data", () => {
    const state = normalizeBootstrap(createPayload());

    expect(state.messageIdsByConversation.conv_old).toEqual([]);
    expect(state.pendingWriteIdsByConversation.conv_old).toEqual([]);
    expect(state.pendingQuestionIdsByConversation.conv_new).toEqual([]);
  });
});

function createPayload(): BootstrapPayload {
  return {
    agents: [],
    conversations: [
      {
        id: "conv_old",
        title: "Old",
        mode: "single",
        agentIds: [],
        fsWriteApprovalMode: "auto",
        pinnedMessageIds: [],
        pinnedAt: null,
        archived: false,
        createdAt: 1,
        updatedAt: 1
      },
      {
        id: "conv_new",
        title: "New",
        mode: "group",
        agentIds: [],
        fsWriteApprovalMode: "review",
        pinnedMessageIds: [],
        pinnedAt: null,
        archived: false,
        createdAt: 2,
        updatedAt: 3
      }
    ],
    messagesByConversation: {
      conv_new: [
        {
          id: "msg_late",
          conversationId: "conv_new",
          role: "user",
          agentId: null,
          runId: null,
          parts: [],
          status: "complete",
          mentionedAgentIds: [],
          parentMessageId: null,
          createdAt: 4,
          updatedAt: 4
        },
        {
          id: "msg_early",
          conversationId: "conv_new",
          role: "user",
          agentId: null,
          runId: null,
          parts: [],
          status: "complete",
          mentionedAgentIds: [],
          parentMessageId: null,
          createdAt: 3,
          updatedAt: 3
        }
      ]
    },
    runsByConversation: {},
    artifactsByConversation: {},
    pendingWrites: [],
    pendingBashCommands: [],
    pendingDispatchPlans: [],
    pendingQuestions: []
  };
}
