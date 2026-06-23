import type {
  Agent,
  AgentRun,
  Artifact,
  Attachment,
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
}
