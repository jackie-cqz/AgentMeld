"use client";

import { create } from "zustand";
import { immer } from "zustand/middleware/immer";
import { requestJson } from "@/lib/request-json";
import { applyStreamEvent } from "@/stores/apply-stream-event";
import { normalizeBootstrap } from "@/stores/normalize-bootstrap";
import { ensureConversationBuckets } from "@/stores/store-helpers";
import { RIGHT_PANEL_WIDTH_STORAGE_KEY } from "@/shared/constants";
import type {
  AppState,
  BootstrapPayload,
  CompactionState,
  DispatchState,
  SearchState,
  SidebarTab
} from "@/stores/store-types";
import type { Message, SearchHit } from "@/shared/types";

export type { AppState, CompactionState, DispatchState, SearchState, SidebarTab };

const DEFAULT_ARTIFACT_PANEL_WIDTH = 640;
let searchRequestId = 0;

export const useAppStore = create<AppState>()(
  immer((set) => ({
    agents: {},
    agentIds: [],
    conversations: {},
    conversationOrder: [],
    messages: {},
    messageIdsByConversation: {},
    runs: {},
    runIdsByConversation: {},
    artifacts: {},
    artifactIdsByConversation: {},
    pendingWrites: {},
    pendingWriteIdsByConversation: {},
    pendingBashCommands: {},
    pendingBashCommandIdsByConversation: {},
    pendingDispatchPlans: {},
    pendingDispatchPlanIdsByConversation: {},
    pendingQuestions: {},
    pendingQuestionIdsByConversation: {},
    dispatchesByRunId: {},
    compactionByConversation: {},
    searchState: createDefaultSearchState(),
    openFilesByConversation: {},
    openDiffsByConversation: {},
    activeTabByConversation: {},
    replyTargetByConversation: {},
    pendingAttachmentsByConversation: {},
    fileRevisionByConversation: {},
    highlightedMessageId: null,
    activeConversationId: null,
    activeArtifactId: null,
    sidebarTab: "conversations",
    rightPanelOpen: true,
    rightPanelMode: "artifact",
    artifactPanelWidth: DEFAULT_ARTIFACT_PANEL_WIDTH,
    connectionStatus: "connecting",
    lastHeartbeatAt: null,
    isBootstrapping: true,
    composerDraftByConversation: {},
    darkMode: false,
    sidebarCollapsed: false,

    async loadBootstrap() {
      set((state) => {
        state.isBootstrapping = true;
      });
      try {
        const payload = await requestJson<BootstrapPayload>("/api/bootstrap", { cache: "no-store" });
        const normalized = normalizeBootstrap(payload);

        set((state) => {
          const currentConversationId = state.activeConversationId;
          Object.assign(state, normalized);
          state.activeConversationId =
            currentConversationId && normalized.conversations[currentConversationId]
              ? currentConversationId
              : normalized.conversationOrder[0] ?? null;
          state.isBootstrapping = false;
        });
      } catch (error) {
        set((state) => {
          state.isBootstrapping = false;
        });
        throw error;
      }
    },

    async createConversation(payload) {
      const { conversation } = await requestJson<{
        conversation: AppState["conversations"][string];
      }>("/api/conversations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload ?? {})
      });

      set((state) => {
        state.conversations[conversation.id] = conversation;
        state.conversationOrder = [
          conversation.id,
          ...state.conversationOrder.filter((id) => id !== conversation.id)
        ];
        ensureConversationBuckets(state, conversation.id);
        state.activeConversationId = conversation.id;
        state.sidebarTab = "conversations";
      });
    },

    async sendMessage(conversationId, content, options = {}) {
      const now = Date.now();
      const tempId = `local-${now}-${Math.random().toString(36).slice(2, 8)}`;
      const attachments = useAppStore.getState().pendingAttachmentsByConversation[conversationId] ?? [];
      const optimisticMessage: Message = {
        id: tempId,
        conversationId,
        role: "user",
        agentId: null,
        runId: null,
        parts: [
          { type: "text", content },
          ...attachments.map((attachment) => attachment.kind === "image"
            ? {
                type: "image_attachment" as const,
                attachmentId: attachment.id,
                fileName: attachment.fileName,
                size: attachment.size,
                mimeType: attachment.mimeType
              }
            : {
                type: "file_attachment" as const,
                attachmentId: attachment.id,
                fileName: attachment.fileName,
                size: attachment.size,
                mimeType: attachment.mimeType
              })
        ],
        status: "complete",
        mentionedAgentIds: options.mentionedAgentIds ?? [],
        parentMessageId: options.parentMessageId ?? null,
        createdAt: now,
        updatedAt: now
      };

      set((state) => {
        state.messages[tempId] = optimisticMessage;
        ensureConversationBuckets(state, conversationId);
        state.messageIdsByConversation[conversationId].push(tempId);
      });

      try {
        const result = await requestJson<{ message: Message }>(
          `/api/conversations/${conversationId}/messages`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              content,
              mentionedAgentIds: options.mentionedAgentIds,
              attachmentIds: options.attachmentIds,
              parentMessageId: options.parentMessageId
            })
          }
        );
        set((state) => {
          delete state.messages[tempId];
          const currentIds = state.messageIdsByConversation[conversationId] ?? [];
          const tempIndex = currentIds.indexOf(tempId);
          const nextIds = currentIds.filter((id) => id !== tempId && id !== result.message.id);
          const insertionIndex = tempIndex >= 0
            ? currentIds.slice(0, tempIndex).filter((id) => id !== result.message.id).length
            : nextIds.length;
          state.messages[result.message.id] = result.message;
          nextIds.splice(insertionIndex, 0, result.message.id);
          state.messageIdsByConversation[conversationId] = nextIds;
          state.composerDraftByConversation[conversationId] = "";
          state.pendingAttachmentsByConversation[conversationId] = [];
          state.replyTargetByConversation[conversationId] = null;
        });
      } catch (error) {
        set((state) => {
          const local = state.messages[tempId];
          if (local) {
            local.status = "error";
            local.parts.push({
              type: "text",
              content: `发送失败：${error instanceof Error ? error.message : "未知错误"}`
            });
          }
        });
        throw error;
      }
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

    setSidebarTab(tab: SidebarTab) {
      set((state) => {
        state.sidebarTab = tab;
      });
    },

    setRightPanelOpen(open) {
      set((state) => {
        state.rightPanelOpen = open;
      });
    },

    setRightPanelMode(mode) {
      set((state) => {
        state.rightPanelMode = mode;
        state.rightPanelOpen = true;
      });
    },

    setArtifactPanelWidth(width) {
      set((state) => {
        state.artifactPanelWidth =
          typeof width === "function" ? width(state.artifactPanelWidth) : width;
        if (typeof window !== "undefined") {
          window.localStorage.setItem(RIGHT_PANEL_WIDTH_STORAGE_KEY, String(state.artifactPanelWidth));
        }
      });
    },

    setConnectionStatus(status) {
      set((state) => {
        state.connectionStatus = status;
      });
    },

    setComposerDraft(conversationId, draft) {
      set((state) => {
        state.composerDraftByConversation[conversationId] = draft;
      });
    },

    setReplyTarget(conversationId, messageId) {
      set((state) => {
        state.replyTargetByConversation[conversationId] = messageId;
      });
    },

    addPendingAttachment(conversationId, attachment) {
      set((state) => {
        const current = state.pendingAttachmentsByConversation[conversationId] ?? [];
        if (!current.some((item) => item.id === attachment.id)) {
          state.pendingAttachmentsByConversation[conversationId] = [...current, attachment];
        }
      });
    },

    removePendingAttachment(conversationId, attachmentId) {
      set((state) => {
        state.pendingAttachmentsByConversation[conversationId] = (
          state.pendingAttachmentsByConversation[conversationId] ?? []
        ).filter((attachment) => attachment.id !== attachmentId);
      });
    },

    clearComposer(conversationId) {
      set((state) => {
        state.composerDraftByConversation[conversationId] = "";
        state.pendingAttachmentsByConversation[conversationId] = [];
        state.replyTargetByConversation[conversationId] = null;
      });
    },

    toggleDarkMode() {
      set((state) => {
        state.darkMode = !state.darkMode;
      });
    },

    toggleSidebarCollapsed() {
      set((state) => {
        state.sidebarCollapsed = !state.sidebarCollapsed;
      });
    },

    updateConversation(id, patch) {
      set((state) => {
        const conv = state.conversations[id];
        if (conv) Object.assign(conv, patch);
        // Move to top of order when updated
        state.conversationOrder = [id, ...state.conversationOrder.filter((oid) => oid !== id)];
      });
    },

    openConversationFile(conversationId, filePath) {
      set((state) => {
        const files = state.openFilesByConversation[conversationId] ?? [];
        if (!files.includes(filePath)) {
          state.openFilesByConversation[conversationId] = [...files, filePath];
          state.activeTabByConversation[conversationId] = `file:${filePath}`;
        } else {
          state.activeTabByConversation[conversationId] = `file:${filePath}`;
        }
      });
    },

    closeConversationFile(conversationId, filePath) {
      set((state) => {
        const currentFiles = state.openFilesByConversation[conversationId] ?? [];
        const closedIndex = currentFiles.indexOf(filePath);
        const files = currentFiles.filter((f) => f !== filePath);
        state.openFilesByConversation[conversationId] = files;
        if (state.activeTabByConversation[conversationId] === `file:${filePath}`) {
          const adjacent = files[Math.min(Math.max(closedIndex, 0), files.length - 1)];
          state.activeTabByConversation[conversationId] = adjacent ? `file:${adjacent}` : "chat";
        }
      });
    },

    openPendingWriteDiff(conversationId, pendingId) {
      set((state) => {
        const diffs = state.openDiffsByConversation[conversationId] ?? [];
        if (!diffs.includes(pendingId)) {
          state.openDiffsByConversation[conversationId] = [...diffs, pendingId];
        }
        state.activeTabByConversation[conversationId] = `diff:${pendingId}`;
      });
    },

    closeConversationTab(conversationId, tabId) {
      if (tabId.startsWith("file:")) {
        useAppStore.getState().closeConversationFile(conversationId, tabId.slice(5));
        return;
      }
      if (tabId.startsWith("diff:")) {
        set((state) => {
          const pendingId = tabId.slice(5);
          const diffs = (state.openDiffsByConversation[conversationId] ?? []).filter(
            (id) => id !== pendingId
          );
          state.openDiffsByConversation[conversationId] = diffs;
          if (state.activeTabByConversation[conversationId] === tabId) {
            const files = state.openFilesByConversation[conversationId] ?? [];
            state.activeTabByConversation[conversationId] =
              diffs.length > 0
                ? `diff:${diffs[diffs.length - 1]}`
                : files.length > 0
                  ? `file:${files[files.length - 1]}`
                  : "chat";
          }
        });
      }
    },

    setActiveConversationTab(conversationId, tabId) {
      set((state) => {
        state.activeTabByConversation[conversationId] = tabId;
      });
    },

    setSearchOpen(open) {
      set((state) => {
        state.searchState.isOpen = open;
        state.searchState.error = null;
      });
    },

    setSearchQuery(query) {
      set((state) => {
        state.searchState.query = query;
        if (!query.trim()) {
          state.searchState.status = "idle";
          state.searchState.results = [];
          state.searchState.total = 0;
          state.searchState.error = null;
        }
      });
    },

    async runSearch() {
      const query = useAppStore.getState().searchState.query.trim();
      if (query.length < 2) {
        set((state) => {
          state.searchState.status = "idle";
          state.searchState.results = [];
          state.searchState.total = 0;
          state.searchState.error = null;
        });
        return;
      }

      const requestId = ++searchRequestId;
      const hanCount = query.match(/\p{Script=Han}/gu)?.length ?? 0;
      const fallback = hanCount > 0 && hanCount < 3 ? "like" : null;
      set((state) => {
        state.searchState.status = "loading";
        state.searchState.error = null;
      });

      const params = new URLSearchParams({ q: query, limit: "30" });
      if (fallback) params.set("fallback", fallback);

      try {
        const response = await fetch(`/api/search?${params.toString()}`, { cache: "no-store" });
        const payload = await response.json() as {
          ok: boolean;
          data?: { hits: SearchHit[]; total: number; mode: "fts" | "like" };
          error?: { message?: string };
        };
        if (!response.ok || !payload.ok || !payload.data) {
          throw new Error(payload.error?.message ?? "搜索失败。");
        }
        if (requestId !== searchRequestId) return;
        set((state) => {
          state.searchState.status = "ready";
          state.searchState.results = payload.data!.hits;
          state.searchState.total = payload.data!.total;
          state.searchState.mode = payload.data!.mode;
        });
      } catch (error) {
        if (requestId !== searchRequestId) return;
        set((state) => {
          state.searchState.status = "error";
          state.searchState.results = [];
          state.searchState.total = 0;
          state.searchState.error = error instanceof Error ? error.message : "搜索失败。";
        });
      }
    },

    jumpToSearchHit(hit) {
      set((state) => {
        state.activeConversationId = hit.conversationId;
        state.sidebarTab = "conversations";
        state.searchState.isOpen = false;
        state.highlightedMessageId = hit.messageId;
      });
      globalThis.setTimeout(() => {
        useAppStore.getState().clearSearchHighlight();
      }, 2200);
    },

    clearSearchHighlight() {
      set((state) => {
        state.highlightedMessageId = null;
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
        applyStreamEvent(state, event);
      });
    }
  }))
);

function createDefaultSearchState(): SearchState {
  return {
    isOpen: false,
    query: "",
    status: "idle",
    results: [],
    total: 0,
    mode: "fts",
    error: null
  };
}
