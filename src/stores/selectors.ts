import type { AppState } from "@/stores/store-types";

export function selectActiveConversation(state: AppState) {
  return state.activeConversationId ? state.conversations[state.activeConversationId] ?? null : null;
}

export function selectConversationList(state: AppState) {
  return state.conversationOrder
    .map((id) => state.conversations[id])
    .filter((conversation) => conversation !== undefined);
}

export function selectAgentList(state: AppState) {
  return state.agentIds
    .map((id) => state.agents[id])
    .filter((agent) => agent !== undefined);
}

export function selectConversationMessages(state: AppState, conversationId: string | null) {
  if (!conversationId) return [];
  return (state.messageIdsByConversation[conversationId] ?? [])
    .map((id) => state.messages[id])
    .filter((message) => message !== undefined);
}

export function selectConversationRuns(state: AppState, conversationId: string | null) {
  if (!conversationId) return [];
  return (state.runIdsByConversation[conversationId] ?? [])
    .map((id) => state.runs[id])
    .filter((run) => run !== undefined);
}

export function selectConversationArtifacts(state: AppState, conversationId: string | null) {
  if (!conversationId) return [];
  return (state.artifactIdsByConversation[conversationId] ?? [])
    .map((id) => state.artifacts[id])
    .filter((artifact) => artifact !== undefined);
}

export function selectSelectedArtifact(state: AppState) {
  return state.activeArtifactId ? state.artifacts[state.activeArtifactId] ?? null : null;
}

export function selectLatestUserMessageId(state: AppState, conversationId: string | null) {
  if (!conversationId) return null;
  const ids = state.messageIdsByConversation[conversationId] ?? [];
  for (let i = ids.length - 1; i >= 0; i--) {
    const message = state.messages[ids[i]];
    if (message?.role === "user") return message.id;
  }
  return null;
}

export function selectConversationPendingWrites(state: AppState, conversationId: string | null) {
  if (!conversationId) return [];
  return (state.pendingWriteIdsByConversation[conversationId] ?? [])
    .map((id) => state.pendingWrites[id])
    .filter((write) => write !== undefined);
}

export function selectConversationPendingBashCommands(state: AppState, conversationId: string | null) {
  if (!conversationId) return [];
  return (state.pendingBashCommandIdsByConversation[conversationId] ?? [])
    .map((id) => state.pendingBashCommands[id])
    .filter((command) => command !== undefined);
}

export function selectConversationPendingQuestions(state: AppState, conversationId: string | null) {
  if (!conversationId) return [];
  return (state.pendingQuestionIdsByConversation[conversationId] ?? [])
    .map((id) => state.pendingQuestions[id])
    .filter((question) => question !== undefined);
}

export function selectConversationPendingDispatchPlans(state: AppState, conversationId: string | null) {
  if (!conversationId) return [];
  return (state.pendingDispatchPlanIdsByConversation[conversationId] ?? [])
    .map((id) => state.pendingDispatchPlans[id])
    .filter((plan) => plan !== undefined);
}

export function selectDispatchStateForRun(state: AppState, runId: string | null) {
  return runId ? state.dispatchesByRunId[runId] ?? null : null;
}

export function selectCompactionState(state: AppState, conversationId: string | null) {
  return conversationId ? state.compactionByConversation[conversationId] ?? null : null;
}

export function selectSearchState(state: AppState) {
  return state.searchState;
}

export function selectSearchResults(state: AppState) {
  return state.searchState.results;
}
