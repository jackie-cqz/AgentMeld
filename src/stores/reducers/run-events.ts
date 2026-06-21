import type { StreamEvent } from "@/shared/types";
import { finalizeRunMessages, type StoreDraft, upsertRun } from "@/stores/store-helpers";

export function applyRunEvent(state: StoreDraft, event: StreamEvent) {
  if (event.type === "run.start") {
    upsertRun(state, {
      id: event.runId,
      conversationId: event.conversationId,
      agentId: event.agentId,
      triggerMessageId: event.triggerMessageId,
      parentRunId: event.parentRunId ?? null,
      status: "running",
      stage: null,
      error: null,
      errorCategory: null,
      retryable: false,
      usage: null,
      interrupted: false,
      startedAt: event.timestamp,
      finishedAt: null,
      createdAt: event.timestamp,
      updatedAt: event.timestamp
    });
    return true;
  }

  if (event.type === "run.end") {
    const run = state.runs[event.runId];
    if (run) {
      run.status = event.status;
      run.error = event.error ?? null;
      run.finishedAt = event.timestamp;
      run.updatedAt = event.timestamp;
    }
    finalizeRunMessages(state, event.conversationId, event.runId, event.status);
    return true;
  }

  if (event.type === "run.usage") {
    const run = state.runs[event.runId];
    if (run) {
      run.usage = event.usage;
      run.updatedAt = event.timestamp;
    }
    return true;
  }

  return false;
}
