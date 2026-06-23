import type { StreamEvent } from "@/shared/types";
import {
  isAppendablePart,
  removeArtifacts,
  removeMessages,
  type StoreDraft,
  upsertMessage
} from "@/stores/store-helpers";

export function applyMessageEvent(state: StoreDraft, event: StreamEvent) {
  if (event.type === "message.added") {
    upsertMessage(state, event.message);
    state.conversationOrder = [
      event.conversationId,
      ...state.conversationOrder.filter((id) => id !== event.conversationId)
    ];
    return true;
  }

  if (event.type === "message.start") {
    upsertMessage(state, {
      id: event.messageId,
      conversationId: event.conversationId,
      role: "agent",
      agentId: event.agentId,
      runId: event.runId,
      parts: [],
      status: "streaming",
      mentionedAgentIds: [],
      parentMessageId: null,
      createdAt: event.timestamp,
      updatedAt: event.timestamp
    });
    return true;
  }

  if (event.type === "message.removed") {
    removeMessages(state, event.conversationId, event.messageIds);
    removeArtifacts(state, event.conversationId, event.artifactIds);
    if (state.activeArtifactId && event.artifactIds.includes(state.activeArtifactId)) {
      state.activeArtifactId = null;
      state.rightPanelOpen = false;
    }
    return true;
  }

  if (event.type === "part.start") {
    const message = state.messages[event.messageId];
    if (message) {
      message.parts[event.partIndex] = event.part;
      message.updatedAt = event.timestamp;
    }
    return true;
  }

  if (event.type === "part.delta") {
    const message = state.messages[event.messageId];
    const part = message?.parts[event.partIndex];
    if (message && isAppendablePart(part) && event.delta.type === `${part.type}.append`) {
      part.content += event.delta.text;
      message.updatedAt = event.timestamp;
    }
    return true;
  }

  if (event.type === "part.end") return true;

  if (event.type === "message.end") {
    const message = state.messages[event.messageId];
    if (message) {
      message.status = event.status ?? "complete";
      message.updatedAt = event.timestamp;
    }
    return true;
  }

  if (event.type === "message.usage") {
    const message = state.messages[event.messageId];
    if (message) message.updatedAt = event.timestamp;
    return true;
  }

  return false;
}
