"use client";

import { create } from "zustand";
import { immer } from "zustand/middleware/immer";
import { applyStreamEvent } from "@/stores/apply-stream-event";
import { normalizeBootstrap } from "@/stores/normalize-bootstrap";
import { ensureConversationBuckets } from "@/stores/store-helpers";
import type {
  AppState,
  BootstrapPayload,
  CompactionState,
  DispatchState,
  SearchState,
  SidebarTab
} from "@/stores/store-types";
import type { SearchHit } from "@/shared/types";

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
    activeTabByConversation: {},
    replyTargetByConversation: {},
    pendingAttachmentsByConversation: {},
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
      const response = await fetch("/api/bootstrap", { cache: "no-store" });
      if (!response.ok) throw new Error("Bootstrap failed.");
      const payload = (await response.json()) as BootstrapPayload;
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
    },

    async createConversation(payload) {
      const response = await fetch("/api/conversations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload ?? {})
      });
      if (!response.ok) throw new Error("Create conversation failed.");
      const { conversation } = (await response.json()) as {
        conversation: AppState["conversations"][string];
      };

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

    async sendMessage(conversationId, content, mentionedAgentIds) {
      const response = await fetch(`/api/conversations/${conversationId}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content, mentionedAgentIds })
      });
      if (!response.ok) throw new Error("Send message failed.");
      set((state) => {
        state.composerDraftByConversation[conversationId] = "";
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
        const files = (state.openFilesByConversation[conversationId] ?? []).filter((f) => f !== filePath);
        state.openFilesByConversation[conversationId] = files;
        if (state.activeTabByConversation[conversationId] === `file:${filePath}`) {
          state.activeTabByConversation[conversationId] = files.length > 0 ? `file:${files[files.length - 1]}` : "chat";
        }
      });
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
