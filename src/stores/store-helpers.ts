import type { Draft } from "immer";
import type {
  AgentRun,
  AgentRunStatus,
  Artifact,
  Message,
  MessagePart,
  PendingBashCommand,
  PendingDispatchPlan,
  PendingQuestion,
  PendingWrite
} from "@/shared/types";
import type { AppState, CompactionState, DispatchState } from "@/stores/store-types";

export type StoreDraft = Draft<AppState>;

export function ensureConversationBuckets(state: StoreDraft, conversationId: string) {
  state.messageIdsByConversation[conversationId] ??= [];
  state.runIdsByConversation[conversationId] ??= [];
  state.artifactIdsByConversation[conversationId] ??= [];
  state.pendingWriteIdsByConversation[conversationId] ??= [];
  state.pendingBashCommandIdsByConversation[conversationId] ??= [];
  state.pendingDispatchPlanIdsByConversation[conversationId] ??= [];
  state.pendingQuestionIdsByConversation[conversationId] ??= [];
}

export function upsertMessage(state: StoreDraft, message: Message) {
  ensureConversationBuckets(state, message.conversationId);
  state.messages[message.id] = message;
  addIdToBucket(state.messageIdsByConversation, message.conversationId, message.id);
}

export function removeMessages(state: StoreDraft, conversationId: string, messageIds: string[]) {
  const removedIds = new Set(messageIds);
  for (const id of removedIds) delete state.messages[id];
  state.messageIdsByConversation[conversationId] = (state.messageIdsByConversation[conversationId] ?? []).filter(
    (id) => !removedIds.has(id)
  );
}

export function upsertRun(state: StoreDraft, run: AgentRun) {
  ensureConversationBuckets(state, run.conversationId);
  state.runs[run.id] = run;
  addIdToBucket(state.runIdsByConversation, run.conversationId, run.id);
}

export function upsertArtifact(state: StoreDraft, artifact: Artifact) {
  ensureConversationBuckets(state, artifact.conversationId);
  state.artifacts[artifact.id] = artifact;
  addIdToBucket(state.artifactIdsByConversation, artifact.conversationId, artifact.id);
}

export function removeArtifacts(state: StoreDraft, conversationId: string, artifactIds: string[]) {
  const removedIds = new Set(artifactIds);
  for (const id of removedIds) delete state.artifacts[id];
  state.artifactIdsByConversation[conversationId] = (state.artifactIdsByConversation[conversationId] ?? []).filter(
    (id) => !removedIds.has(id)
  );
}

export function upsertPendingWrite(state: StoreDraft, pendingWrite: PendingWrite) {
  ensureConversationBuckets(state, pendingWrite.conversationId);
  state.pendingWrites[pendingWrite.id] = pendingWrite;
  addIdToBucket(state.pendingWriteIdsByConversation, pendingWrite.conversationId, pendingWrite.id);
}

export function upsertPendingBashCommand(state: StoreDraft, pendingCommand: PendingBashCommand) {
  ensureConversationBuckets(state, pendingCommand.conversationId);
  state.pendingBashCommands[pendingCommand.id] = pendingCommand;
  addIdToBucket(state.pendingBashCommandIdsByConversation, pendingCommand.conversationId, pendingCommand.id);
}

export function upsertPendingDispatchPlan(state: StoreDraft, pendingPlan: PendingDispatchPlan) {
  ensureConversationBuckets(state, pendingPlan.conversationId);
  state.pendingDispatchPlans[pendingPlan.id] = pendingPlan;
  addIdToBucket(state.pendingDispatchPlanIdsByConversation, pendingPlan.conversationId, pendingPlan.id);
}

export function upsertPendingQuestion(state: StoreDraft, pendingQuestion: PendingQuestion) {
  ensureConversationBuckets(state, pendingQuestion.conversationId);
  state.pendingQuestions[pendingQuestion.id] = pendingQuestion;
  addIdToBucket(state.pendingQuestionIdsByConversation, pendingQuestion.conversationId, pendingQuestion.id);
}

export function removeIdFromBucket(buckets: Draft<Record<string, string[]>>, key: string, id: string) {
  buckets[key] = (buckets[key] ?? []).filter((existing) => existing !== id);
}

export function finalizeRunMessages(
  state: StoreDraft,
  conversationId: string,
  runId: string,
  status: AgentRunStatus
) {
  const terminalStatus = status === "failed" ? "error"
    : status === "aborted" ? "aborted"
    : "complete";
  for (const id of state.messageIdsByConversation[conversationId] ?? []) {
    const message = state.messages[id];
    if (!message || message.runId !== runId) continue;
    if (message.status === "streaming") message.status = terminalStatus;

    // Fill any unpaired tool_use with a synthetic tool_result.
    // This handles dropped/missed SSE tool.result events so tool cards
    // don't stay stuck in "执行中" forever — for all run outcomes.
    const toolUseParts = message.parts.filter((part) => part.type === "tool_use");
    const toolResultCallIds = new Set(
      message.parts.filter((part) => part.type === "tool_result").map((part) => part.callId)
    );
    for (const toolUse of toolUseParts) {
      if (!toolResultCallIds.has(toolUse.callId)) {
        message.parts.push({
          type: "tool_result",
          callId: toolUse.callId,
          result: status === "complete" ? "Tool call completed." : `Run ${status}: tool call did not complete.`,
          isError: status !== "complete"
        });
      }
    }
  }
}

export function createDispatchState(
  conversationId: string,
  runId: string,
  plan: PendingDispatchPlan["plan"],
  messageId: string | null
): DispatchState {
  return {
    runId,
    conversationId,
    messageId,
    plan,
    taskStatus: Object.fromEntries(plan.map((item) => [item.id, "pending"])),
    childRunIds: {},
    attempts: {},
    errors: {}
  };
}

export function ensureDispatchState(state: StoreDraft, conversationId: string, runId: string) {
  state.dispatchesByRunId[runId] ??= createDispatchState(
    conversationId,
    runId,
    [],
    findLatestMessageIdForRun(state, conversationId, runId)
  );
  return state.dispatchesByRunId[runId];
}

export function findLatestMessageIdForRun(state: StoreDraft, conversationId: string, runId: string) {
  const ids = state.messageIdsByConversation[conversationId] ?? [];
  for (let index = ids.length - 1; index >= 0; index--) {
    const message = state.messages[ids[index]];
    if (message?.runId === runId) return message.id;
  }
  return null;
}

export function defaultCompactionState(): CompactionState {
  return {
    status: "idle",
    stage: null,
    sourceMessageCount: 0,
    detail: null,
    coveredUntilMessageId: null,
    summary: null,
    tokenEstimate: null,
    updatedAt: null
  };
}

export function isAppendablePart(
  part: MessagePart | undefined
): part is Extract<MessagePart, { type: "text" | "thinking" | "code" }> {
  return part?.type === "text" || part?.type === "thinking" || part?.type === "code";
}

function addIdToBucket(buckets: Draft<Record<string, string[]>>, key: string, id: string) {
  const bucket = buckets[key] ?? [];
  buckets[key] = bucket.includes(id) ? bucket : [...bucket, id];
}
