import type { StreamEvent } from "@/shared/types";
import { defaultCompactionState, type StoreDraft } from "@/stores/store-helpers";

export function applyCompactionEvent(state: StoreDraft, event: StreamEvent) {
  if (event.type === "compaction.start") {
    state.compactionByConversation[event.conversationId] = {
      status: "running",
      stage: "reading",
      sourceMessageCount: event.sourceMessageCount,
      detail: null,
      coveredUntilMessageId: null,
      summary: null,
      tokenEstimate: null,
      updatedAt: event.timestamp
    };
    return true;
  }

  if (event.type === "compaction.progress") {
    const current = state.compactionByConversation[event.conversationId] ?? defaultCompactionState();
    state.compactionByConversation[event.conversationId] = {
      ...current,
      status: "running",
      stage: event.stage,
      detail: event.detail ?? null,
      updatedAt: event.timestamp
    };
    return true;
  }

  if (event.type === "compaction.end") {
    const current = state.compactionByConversation[event.conversationId] ?? defaultCompactionState();
    state.compactionByConversation[event.conversationId] = {
      ...current,
      status: "complete",
      stage: null,
      sourceMessageCount: event.sourceMessageCount,
      coveredUntilMessageId: event.coveredUntilMessageId,
      summary: event.summary,
      tokenEstimate: event.tokenEstimate,
      updatedAt: event.timestamp
    };
    return true;
  }

  if (event.type === "compaction.error") {
    const current = state.compactionByConversation[event.conversationId] ?? defaultCompactionState();
    state.compactionByConversation[event.conversationId] = {
      ...current,
      status: "error",
      stage: null,
      detail: event.error,
      updatedAt: event.timestamp
    };
    return true;
  }

  return false;
}
