import type {
  Agent,
  AgentRun,
  Artifact,
  Conversation,
  Message,
  PendingBashCommand,
  PendingDispatchPlan,
  PendingQuestion,
  PendingWrite
} from "@/shared/types";
import type { BootstrapPayload } from "@/stores/store-types";

export interface NormalizedBootstrapState {
  agents: Record<string, Agent>;
  agentIds: string[];
  conversations: Record<string, Conversation>;
  conversationOrder: string[];
  messages: Record<string, Message>;
  messageIdsByConversation: Record<string, string[]>;
  runs: Record<string, AgentRun>;
  runIdsByConversation: Record<string, string[]>;
  artifacts: Record<string, Artifact>;
  artifactIdsByConversation: Record<string, string[]>;
  pendingWrites: Record<string, PendingWrite>;
  pendingWriteIdsByConversation: Record<string, string[]>;
  pendingBashCommands: Record<string, PendingBashCommand>;
  pendingBashCommandIdsByConversation: Record<string, string[]>;
  pendingDispatchPlans: Record<string, PendingDispatchPlan>;
  pendingDispatchPlanIdsByConversation: Record<string, string[]>;
  pendingQuestions: Record<string, PendingQuestion>;
  pendingQuestionIdsByConversation: Record<string, string[]>;
}

export function normalizeBootstrap(payload: BootstrapPayload): NormalizedBootstrapState {
  const conversations = [...payload.conversations].sort(
    (left, right) => right.updatedAt - left.updatedAt || right.createdAt - left.createdAt
  );
  const state: NormalizedBootstrapState = {
    agents: keyById(payload.agents),
    agentIds: payload.agents.map((agent) => agent.id),
    conversations: keyById(conversations),
    conversationOrder: conversations.map((conversation) => conversation.id),
    messages: {},
    messageIdsByConversation: {},
    runs: {},
    runIdsByConversation: {},
    artifacts: {},
    artifactIdsByConversation: {},
    pendingWrites: keyById(payload.pendingWrites ?? []),
    pendingWriteIdsByConversation: groupIdsByConversation(payload.pendingWrites ?? []),
    pendingBashCommands: keyById(payload.pendingBashCommands ?? []),
    pendingBashCommandIdsByConversation: groupIdsByConversation(payload.pendingBashCommands ?? []),
    pendingDispatchPlans: keyById(payload.pendingDispatchPlans ?? []),
    pendingDispatchPlanIdsByConversation: groupIdsByConversation(payload.pendingDispatchPlans ?? []),
    pendingQuestions: keyById(payload.pendingQuestions ?? []),
    pendingQuestionIdsByConversation: groupIdsByConversation(payload.pendingQuestions ?? [])
  };

  for (const conversation of conversations) {
    const messages = sortByCreatedAt(payload.messagesByConversation[conversation.id] ?? []);
    const runs = sortByCreatedAt(payload.runsByConversation[conversation.id] ?? []);
    const artifacts = sortByCreatedAt(payload.artifactsByConversation[conversation.id] ?? []);
    state.messageIdsByConversation[conversation.id] = messages.map((message) => message.id);
    state.runIdsByConversation[conversation.id] = runs.map((run) => run.id);
    state.artifactIdsByConversation[conversation.id] = artifacts.map((artifact) => artifact.id);
    Object.assign(state.messages, keyById(messages));
    Object.assign(state.runs, keyById(runs));
    Object.assign(state.artifacts, keyById(artifacts));
    ensurePendingBuckets(state, conversation.id);
  }

  return state;
}

function keyById<T extends { id: string }>(items: T[]) {
  return Object.fromEntries(items.map((item) => [item.id, item])) as Record<string, T>;
}

function groupIdsByConversation<T extends { id: string; conversationId: string; createdAt: number }>(items: T[]) {
  const buckets: Record<string, string[]> = {};
  for (const item of sortByCreatedAt(items)) {
    (buckets[item.conversationId] ??= []).push(item.id);
  }
  return buckets;
}

function sortByCreatedAt<T extends { createdAt: number }>(items: T[]) {
  return [...items].sort((left, right) => left.createdAt - right.createdAt);
}

function ensurePendingBuckets(state: NormalizedBootstrapState, conversationId: string) {
  state.pendingWriteIdsByConversation[conversationId] ??= [];
  state.pendingBashCommandIdsByConversation[conversationId] ??= [];
  state.pendingDispatchPlanIdsByConversation[conversationId] ??= [];
  state.pendingQuestionIdsByConversation[conversationId] ??= [];
}
