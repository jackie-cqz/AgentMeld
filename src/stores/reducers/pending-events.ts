import type { StreamEvent } from "@/shared/types";
import {
  removeIdFromBucket,
  type StoreDraft,
  upsertPendingBashCommand,
  upsertPendingQuestion,
  upsertPendingWrite
} from "@/stores/store-helpers";

export function applyPendingEvent(state: StoreDraft, event: StreamEvent) {
  if (event.type === "fs_write.pending") {
    upsertPendingWrite(state, event.pendingWrite);
    return true;
  }

  if (event.type === "fs_write.resolved") {
    removeIdFromBucket(state.pendingWriteIdsByConversation, event.conversationId, event.pendingId);
    delete state.pendingWrites[event.pendingId];
    if (event.applied) {
      state.fileRevisionByConversation[event.conversationId] =
        (state.fileRevisionByConversation[event.conversationId] ?? 0) + 1;
    }
    return true;
  }

  if (event.type === "bash_command.pending") {
    upsertPendingBashCommand(state, event.pendingCommand);
    return true;
  }

  if (event.type === "bash_command.resolved") {
    removeIdFromBucket(state.pendingBashCommandIdsByConversation, event.conversationId, event.pendingId);
    delete state.pendingBashCommands[event.pendingId];
    return true;
  }

  if (event.type === "ask_user.pending") {
    upsertPendingQuestion(state, event.pendingQuestion);
    return true;
  }

  if (event.type === "ask_user.answered" || event.type === "ask_user.cancelled") {
    removeIdFromBucket(state.pendingQuestionIdsByConversation, event.conversationId, event.pendingId);
    delete state.pendingQuestions[event.pendingId];
    return true;
  }

  return false;
}
