import type {
  Agent,
  AgentRun,
  Artifact,
  Attachment,
  ChannelBinding,
  ChannelBindingSession,
  ChannelConnectionInfo,
  Conversation,
  Message,
  PendingBashCommand,
  PendingDispatchPlan,
  PendingQuestion,
  PendingWrite,
  SearchHit,
  StreamEvent
} from "@/shared/types";

export type ConnectionStatus = "connecting" | "open" | "closed" | "error";
export type SidebarTab = "conversations" | "artifacts" | "agents" | "analytics";

export interface BootstrapPayload {
  agents: Agent[];
  conversations: Conversation[];
  messagesByConversation: Record<string, Message[]>;
  runsByConversation: Record<string, AgentRun[]>;
  artifactsByConversation: Record<string, Artifact[]>;
  pendingWrites: PendingWrite[];
  pendingBashCommands: PendingBashCommand[];
  pendingDispatchPlans: PendingDispatchPlan[];
  pendingQuestions?: PendingQuestion[];
}

export interface CreateConversationPayload {
  title?: string;
  mode?: "single" | "group";
  agentIds?: string[];
  fsWriteApprovalMode?: "auto" | "review";
}

export interface DispatchState {
  runId: string;
  conversationId: string;
  messageId: string | null;
  plan: PendingDispatchPlan["plan"];
  taskStatus: Record<string, "pending" | "running" | "complete" | "failed" | "aborted" | "skipped" | "blocked">;
  childRunIds: Record<string, string>;
  attempts: Record<string, number>;
  errors: Record<string, string>;
  reviewStatus?: "pending" | "approved" | "rejected";
  pendingPlanId?: string;
  // ── P7: Evidence-aware context observability ───────────────────────────
  attemptIdsByTask: Record<string, string[]>;
  activeAttemptByTask: Record<string, string>;
  verificationStatusByTask: Record<string, "checking" | "verified" | "rejected" | "needs_review">;
  contextSummaryByAttempt: Record<string, { tokenEstimate: number; includedCount: number; omittedCount: number }>;
  evidenceCountByAttempt: Record<string, number>;
  verdictSummaryByAttempt: Record<string, { passed: number; failed: number; missing: number; needsReview: number }>;
}

export interface CompactionState {
  status: "idle" | "running" | "complete" | "error";
  stage: "reading" | "summarizing" | "storing" | null;
  sourceMessageCount: number;
  detail: string | null;
  coveredUntilMessageId: string | null;
  summary: string | null;
  tokenEstimate: number | null;
  updatedAt: number | null;
}

export interface SearchState {
  isOpen: boolean;
  query: string;
  status: "idle" | "loading" | "ready" | "error";
  results: SearchHit[];
  total: number;
  mode: "fts" | "like";
  error: string | null;
}

export interface SendMessageOptions {
  mentionedAgentIds?: string[];
  attachmentIds?: string[];
  parentMessageId?: string | null;
}

export interface AppState {
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

  dispatchesByRunId: Record<string, DispatchState>;
  compactionByConversation: Record<string, CompactionState>;
  searchState: SearchState;

  /** Stored Feishu bindings, keyed by agent id. Never contains an app secret. */
  channelBindings: Record<string, ChannelBinding>;
  /** In-flight scan-to-bind attempts, keyed by session id. */
  channelBindingSessions: Record<string, ChannelBindingSession>;
  /**
   * Long-connection health, keyed by agent id. Kept beside the bindings so
   * "bound but not connected" is visible — otherwise a bot that cannot receive
   * anything looks identical to one that is merely quiet.
   */
  channelConnections: Record<string, ChannelConnectionInfo>;
  channelBindingError: string | null;
  channelBindingsLoaded: boolean;

  openFilesByConversation: Record<string, string[]>;
  openDiffsByConversation: Record<string, string[]>;
  activeTabByConversation: Record<string, string>;
  replyTargetByConversation: Record<string, string | null>;
  pendingAttachmentsByConversation: Record<string, Attachment[]>;
  fileRevisionByConversation: Record<string, number>;
  highlightedMessageId: string | null;

  activeConversationId: string | null;
  activeArtifactId: string | null;
  sidebarTab: SidebarTab;
  rightPanelOpen: boolean;
  rightPanelMode: "artifact" | "files";
  artifactPanelWidth: number;
  connectionStatus: ConnectionStatus;
  lastHeartbeatAt: number | null;
  isBootstrapping: boolean;
  composerDraftByConversation: Record<string, string>;
  darkMode: boolean;
  sidebarCollapsed: boolean;

  loadBootstrap: () => Promise<void>;
  createConversation: (payload?: CreateConversationPayload) => Promise<void>;
  sendMessage: (conversationId: string, content: string, options?: SendMessageOptions) => Promise<void>;
  setActiveConversation: (conversationId: string) => void;
  setActiveArtifact: (artifactId: string | null) => void;
  setSidebarTab: (tab: SidebarTab) => void;
  setRightPanelOpen: (open: boolean) => void;
  setRightPanelMode: (mode: "artifact" | "files") => void;
  setArtifactPanelWidth: (width: number | ((prev: number) => number)) => void;
  setConnectionStatus: (status: ConnectionStatus) => void;
  setComposerDraft: (conversationId: string, draft: string) => void;
  setReplyTarget: (conversationId: string, messageId: string | null) => void;
  addPendingAttachment: (conversationId: string, attachment: Attachment) => void;
  removePendingAttachment: (conversationId: string, attachmentId: string) => void;
  clearComposer: (conversationId: string) => void;
  toggleDarkMode: () => void;
  toggleSidebarCollapsed: () => void;
  updateConversation: (id: string, patch: Partial<Conversation>) => void;
  openConversationFile: (conversationId: string, filePath: string) => void;
  closeConversationFile: (conversationId: string, filePath: string) => void;
  openPendingWriteDiff: (conversationId: string, pendingId: string) => void;
  closeConversationTab: (conversationId: string, tabId: string) => void;
  setActiveConversationTab: (conversationId: string, tabId: string) => void;
  setSearchOpen: (open: boolean) => void;
  setSearchQuery: (query: string) => void;
  runSearch: () => Promise<void>;
  jumpToSearchHit: (hit: SearchHit) => void;
  clearSearchHighlight: () => void;
  applyEvent: (event: StreamEvent) => void;

  /**
   * `preserveError` is for passive refreshes: a successful read must not erase a
   * message the user still needs to see from an action that just failed.
   */
  loadChannelBindings: (options?: { preserveError?: boolean }) => Promise<void>;
  /** Reads the connection health endpoint; also (re)starts anything missing. */
  loadChannelConnections: () => Promise<void>;
  startFeishuBinding: (agentId: string) => Promise<void>;
  /**
   * Bind from credentials a person typed. Returns the one-time claim code the
   * person then sends to the bot in the group: the credentials carry no human
   * identity, so the binding stays fail-closed until that code comes back.
   */
  bindFeishuWithCredentials: (
    agentId: string,
    appId: string,
    appSecret: string
  ) => Promise<{ code: string; expiresAt: number }>;
  cancelChannelBindingSession: (sessionId: string) => Promise<void>;
  unbindFeishu: (agentId: string) => Promise<void>;
}
