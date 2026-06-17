"use client";

import { create } from "zustand";
import { immer } from "zustand/middleware/immer";
import type {
  Agent,
  AgentRun,
  Artifact,
  Conversation,
  Message,
  MessagePart,
  PendingBashCommand,
  PendingDispatchPlan,
  PendingWrite,
  StreamEvent
} from "@/shared/types";

type ConnectionStatus = "connecting" | "open" | "closed" | "error";
export type SidebarTab = "conversations" | "artifacts" | "agents" | "analytics";

const DEFAULT_ARTIFACT_PANEL_WIDTH = 640;

interface BootstrapPayload {
  agents: Agent[];
  conversations: Conversation[];
  messagesByConversation: Record<string, Message[]>;
  runsByConversation: Record<string, AgentRun[]>;
  artifactsByConversation: Record<string, Artifact[]>;
  pendingWrites: PendingWrite[];
  pendingBashCommands: PendingBashCommand[];
  pendingDispatchPlans: PendingDispatchPlan[];
}

interface CreateConversationPayload {
  title?: string;
  mode?: "single" | "group";
  agentIds?: string[];
  fsWriteApprovalMode?: "auto" | "review";
}

interface AppState {
  agents: Record<string, Agent>;
  conversations: Record<string, Conversation>;
  conversationOrder: string[];
  messagesByConversation: Record<string, Message[]>;
  runsByConversation: Record<string, AgentRun[]>;
  artifactsByConversation: Record<string, Artifact[]>;
  pendingWrites: Record<string, PendingWrite>;
  pendingBashCommands: Record<string, PendingBashCommand>;
  pendingDispatchPlans: Record<string, PendingDispatchPlan>;
  activeConversationId: string | null;
  activeArtifactId: string | null;
  sidebarTab: SidebarTab;
  rightPanelOpen: boolean;
  artifactPanelWidth: number;
  connectionStatus: ConnectionStatus;
  lastHeartbeatAt: number | null;
  isBootstrapping: boolean;
  composerDraft: string;
  loadBootstrap: () => Promise<void>;
  createConversation: (payload?: CreateConversationPayload) => Promise<void>;
  sendMessage: (conversationId: string, content: string, mentionedAgentIds?: string[]) => Promise<void>;
  setActiveConversation: (conversationId: string) => void;
  setActiveArtifact: (artifactId: string | null) => void;
  setSidebarTab: (tab: SidebarTab) => void;
  setRightPanelOpen: (open: boolean) => void;
  setArtifactPanelWidth: (width: number | ((prev: number) => number)) => void;
  setConnectionStatus: (status: ConnectionStatus) => void;
  setComposerDraft: (draft: string) => void;
  applyEvent: (event: StreamEvent) => void;
}

export const useAppStore = create<AppState>()(
  immer((set, get) => ({
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
    artifactPanelWidth: DEFAULT_ARTIFACT_PANEL_WIDTH,
    connectionStatus: "connecting",
    lastHeartbeatAt: null,
    isBootstrapping: true,
    composerDraft: "",

    async loadBootstrap() {
      set((state) => {
        state.isBootstrapping = true;
      });
      const response = await fetch("/api/bootstrap", { cache: "no-store" });
      if (!response.ok) throw new Error("Bootstrap failed.");
      const payload = (await response.json()) as BootstrapPayload;

      set((state) => {
        state.agents = Object.fromEntries(payload.agents.map((agent) => [agent.id, agent]));
        state.conversations = Object.fromEntries(
          payload.conversations.map((conversation) => [conversation.id, conversation])
        );
        state.conversationOrder = payload.conversations.map((conversation) => conversation.id);
        state.messagesByConversation = payload.messagesByConversation;
        state.runsByConversation = payload.runsByConversation;
        state.artifactsByConversation = payload.artifactsByConversation;
        state.pendingWrites = keyById(payload.pendingWrites ?? []);
        state.pendingBashCommands = keyById(payload.pendingBashCommands ?? []);
        state.pendingDispatchPlans = keyById(payload.pendingDispatchPlans ?? []);
        state.activeConversationId = state.activeConversationId ?? payload.conversations[0]?.id ?? null;
        state.isBootstrapping = false;
      });
    },

    async createConversation(payload) {
      const response = await fetch("/api/conversations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload ?? {})
      });
      if (!response.ok) throw new Error("Create conversation failed.");
      const { conversation } = (await response.json()) as { conversation: Conversation };

      set((state) => {
        state.conversations[conversation.id] = conversation;
        state.conversationOrder = [conversation.id, ...state.conversationOrder.filter((id) => id !== conversation.id)];
        state.messagesByConversation[conversation.id] = [];
        state.runsByConversation[conversation.id] = [];
        state.artifactsByConversation[conversation.id] = [];
        state.activeConversationId = conversation.id;
        state.sidebarTab = "conversations";
      });
    },

    async sendMessage(conversationId, content, mentionedAgentIds) {
      const response = await fetch(`/api/conversations/${conversationId}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content, mentionedAgentIds })
      });
      if (!response.ok) throw new Error("Send message failed.");
      set((state) => {
        state.composerDraft = "";
      });
    },

    setActiveConversation(conversationId) {
      set((state) => {
        state.activeConversationId = conversationId;
      });
    },

    setActiveArtifact(artifactId) {
      set((state) => {
        state.activeArtifactId = artifactId;
        if (artifactId) state.rightPanelOpen = true;
      });
    },

    setSidebarTab(tab) {
      set((state) => {
        state.sidebarTab = tab;
      });
    },

    setRightPanelOpen(open) {
      set((state) => {
        state.rightPanelOpen = open;
      });
    },

    setArtifactPanelWidth(width) {
      set((state) => {
        state.artifactPanelWidth = typeof width === "function" ? width(state.artifactPanelWidth) : width;
      });
    },

    setConnectionStatus(status) {
      set((state) => {
        state.connectionStatus = status;
      });
    },

    setComposerDraft(draft) {
      set((state) => {
        state.composerDraft = draft;
      });
    },

    applyEvent(event) {
      if (event.type === "heartbeat") {
        set((state) => {
          state.lastHeartbeatAt = event.timestamp;
        });
        return;
      }

      set((state) => {
        if (event.type === "run.start") {
          const runs = state.runsByConversation[event.conversationId] ?? [];
          const run: AgentRun = {
            id: event.runId,
            conversationId: event.conversationId,
            agentId: event.agentId,
            triggerMessageId: event.triggerMessageId,
            parentRunId: event.parentRunId ?? null,
            status: "running",
            error: null,
            usage: null,
            startedAt: event.timestamp,
            finishedAt: null,
            createdAt: event.timestamp,
            updatedAt: event.timestamp
          };
          state.runsByConversation[event.conversationId] = upsertById(runs, run);
          return;
        }

        if (event.type === "run.end") {
          const runs = state.runsByConversation[event.conversationId] ?? [];
          const run = runs.find((item) => item.id === event.runId);
          if (run) {
            run.status = event.status;
            run.error = event.error ?? null;
            run.finishedAt = event.timestamp;
            run.updatedAt = event.timestamp;
          }

          // When run fails/aborts, fill unpaired tool_use with synthetic error result
          if (event.status === "failed" || event.status === "aborted") {
            const messages = state.messagesByConversation[event.conversationId] ?? [];
            for (const msg of messages) {
              if (msg.runId !== event.runId) continue;
              const toolUseParts = msg.parts.filter((p) => p.type === "tool_use");
              const toolResultCallIds = new Set(
                msg.parts.filter((p) => p.type === "tool_result").map((p) => p.callId)
              );
              for (const toolUse of toolUseParts) {
                if (!toolResultCallIds.has(toolUse.callId)) {
                  msg.parts.push({
                    type: "tool_result",
                    callId: toolUse.callId,
                    result: `Run ${event.status}: tool call did not complete.`,
                    isError: true
                  });
                }
              }
            }
          }
          return;
        }

        if (event.type === "run.usage") {
          const run = findRun(state.runsByConversation[event.conversationId], event.runId);
          if (run) {
            run.usage = event.usage;
            run.updatedAt = event.timestamp;
          }
          return;
        }

        if (event.type === "message.added") {
          const messages = state.messagesByConversation[event.conversationId] ?? [];
          state.messagesByConversation[event.conversationId] = upsertById(messages, event.message);
          state.conversationOrder = [
            event.conversationId,
            ...state.conversationOrder.filter((id) => id !== event.conversationId)
          ];
          return;
        }

        if (event.type === "message.start") {
          const messages = state.messagesByConversation[event.conversationId] ?? [];
          const message: Message = {
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
          };
          state.messagesByConversation[event.conversationId] = upsertById(messages, message);
          return;
        }

        if (event.type === "message.removed") {
          const messages = state.messagesByConversation[event.conversationId] ?? [];
          state.messagesByConversation[event.conversationId] = messages.filter(
            (message) => !event.messageIds.includes(message.id)
          );
          const artifacts = state.artifactsByConversation[event.conversationId] ?? [];
          state.artifactsByConversation[event.conversationId] = artifacts.filter(
            (artifact) => !event.artifactIds.includes(artifact.id)
          );
          if (state.activeArtifactId && event.artifactIds.includes(state.activeArtifactId)) {
            state.activeArtifactId = null;
            state.rightPanelOpen = false;
          }
          return;
        }

        if (event.type === "part.start") {
          const message = findMessage(state.messagesByConversation[event.conversationId], event.messageId);
          if (message) message.parts[event.partIndex] = event.part;
          return;
        }

        if (event.type === "part.delta") {
          const message = findMessage(state.messagesByConversation[event.conversationId], event.messageId);
          const part = message?.parts[event.partIndex];
          if (isAppendablePart(part) && event.delta.type === `${part.type}.append`) {
            part.content += event.delta.text;
          }
          return;
        }

        if (event.type === "message.end") {
          const message = findMessage(state.messagesByConversation[event.conversationId], event.messageId);
          if (message) {
            message.status = event.status ?? "complete";
            message.updatedAt = event.timestamp;
          }
          return;
        }

        if (event.type === "message.usage") {
          const message = findMessage(state.messagesByConversation[event.conversationId], event.messageId);
          if (message) message.updatedAt = event.timestamp;
          return;
        }

        if (event.type === "tool.call") {
          const message = findMessage(state.messagesByConversation[event.conversationId], event.messageId);
          if (message && !message.parts.some((part) => part.type === "tool_use" && part.callId === event.callId)) {
            message.parts.push({
              type: "tool_use",
              callId: event.callId,
              toolName: event.toolName,
              args: event.args
            });
          }
          return;
        }

        if (event.type === "tool.result") {
          const message = findMessage(state.messagesByConversation[event.conversationId], event.messageId);
          if (message && !message.parts.some((part) => part.type === "tool_result" && part.callId === event.callId)) {
            message.parts.push({
              type: "tool_result",
              callId: event.callId,
              result: event.result,
              isError: event.isError
            });
          }
          return;
        }

        if (event.type === "artifact.create") {
          const artifacts = state.artifactsByConversation[event.conversationId] ?? [];
          state.artifactsByConversation[event.conversationId] = upsertById(artifacts, event.artifact);
          return;
        }

        if (event.type === "artifact.update") {
          const artifact = findArtifact(state.artifactsByConversation[event.conversationId], event.artifactId);
          if (artifact) {
            artifact.content = {
              ...artifact.content,
              ...event.patch
            } as Artifact["content"];
            artifact.updatedAt = event.timestamp;
          }
          return;
        }

        if (event.type === "deploy.status") {
          const message = findMessage(state.messagesByConversation[event.conversationId], event.messageId);
          const alreadyAdded = message?.parts.some(
            (part) => part.type === "deploy_status" && part.deployment.id === event.deployment.id
          );
          if (message && !alreadyAdded) {
            message.parts.push({ type: "deploy_status", deployment: event.deployment });
          }
          return;
        }

        if (event.type === "dispatch.plan.pending") {
          state.pendingDispatchPlans[event.pendingPlan.id] = event.pendingPlan;
          return;
        }

        if (event.type === "dispatch.plan.resolved") {
          delete state.pendingDispatchPlans[event.pendingId];
          return;
        }

        if (event.type === "fs_write.pending") {
          state.pendingWrites[event.pendingWrite.id] = event.pendingWrite;
          return;
        }

        if (event.type === "fs_write.resolved") {
          delete state.pendingWrites[event.pendingId];
          return;
        }

        if (event.type === "bash_command.pending") {
          state.pendingBashCommands[event.pendingCommand.id] = event.pendingCommand;
          return;
        }

        if (event.type === "bash_command.resolved") {
          delete state.pendingBashCommands[event.pendingId];
        }
      });
    }
  }))
);

function upsertById<T extends { id: string }>(items: T[], item: T) {
  const index = items.findIndex((existing) => existing.id === item.id);
  if (index === -1) return [...items, item];
  const next = [...items];
  next[index] = item;
  return next;
}

function keyById<T extends { id: string }>(items: T[]) {
  return Object.fromEntries(items.map((item) => [item.id, item])) as Record<string, T>;
}

function findMessage(messages: Message[] | undefined, messageId: string) {
  return messages?.find((message) => message.id === messageId);
}

function findRun(runs: AgentRun[] | undefined, runId: string) {
  return runs?.find((run) => run.id === runId);
}

function findArtifact(artifacts: Artifact[] | undefined, artifactId: string) {
  return artifacts?.find((artifact) => artifact.id === artifactId);
}

function isAppendablePart(part: MessagePart | undefined): part is Extract<MessagePart, { type: "text" | "thinking" | "code" }> {
  return part?.type === "text" || part?.type === "thinking" || part?.type === "code";
}
