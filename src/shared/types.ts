import type { AgentConsultation, CollaborationTurn, TaskHandoff } from "./collaboration-types";

/** Legacy values remain readable for migration; new production agents use Pi only. */
export type AdapterName = "pi" | "claude-code" | "codex" | "custom" | "mock";

export type ModelProvider =
  | "anthropic"
  | "openai"
  | "deepseek"
  | "volcano-ark"
  | "openai-compatible"
  | `profile:${string}`;

export interface ModelProviderProfile {
  id: string;
  name: string;
  presetId: string | null;
  protocol: "chat-completions";
  baseUrl: string;
  defaultModel: string;
  models: string[];
  credentialSource: "app_settings" | "environment" | "missing";
  agentCount: number;
}

export type ConversationMode = "single" | "group";
export type MessageRole = "user" | "agent" | "system";

/**
 * Who authored a message.
 *
 * `role` says how the conversation should treat a message — an external bot's
 * message is still user-role input as far as the agents are concerned — while
 * `origin` records where it actually came from. Only `human` may start work;
 * see `dispatchTargets` in conversation-service.
 */
export type MessageOrigin = "human" | "bot" | "internal";
export type MessageStatus = "streaming" | "complete" | "error" | "aborted";
export type AgentRunStatus = "queued" | "running" | "complete" | "failed" | "aborted";
export type FsWriteApprovalMode = "auto" | "review";
export type WorkspaceMode = "sandbox" | "local";
export type AttachmentKind = "image" | "file";
export type CompanionMode = "off" | "lan" | "tailnet";

/** Lifecycle of an in-flight "scan to bind" attempt. */
export type ChannelBindingStatus = "awaiting_scan" | "succeeded" | "failed" | "cancelled";

/** Health of a channel's long connection, for the UI and for diagnostics. */
export type ChannelConnectionStatus =
  | "connected"
  | "reconnecting"
  | "reconnected"
  | "disconnected"
  | "error";

/**
 * A normalized inbound message from a channel, before routing.
 *
 * A trimmed, serializable view of the SDK's `NormalizedMessage`: enough to
 * deduplicate, map to a conversation and dispatch. The raw platform payload is
 * dropped — it carries tenant keys, app tickets and attachment descriptors that
 * nothing downstream needs. Identity fields that routing genuinely requires ARE
 * kept (`senderId`, which is the sender's open id), so this is not anonymous;
 * it is the minimum rather than the whole envelope.
 *
 * `senderType` is a plain string on purpose — the platform can send values
 * beyond `user`/`bot`, and an absent value means "unknown", never "not a bot".
 */
export interface ChannelInboundMessage {
  channel: "feishu";
  /** Which agent's bot received it — i.e. whose app got the event. */
  agentId: string;
  chatId: string;
  chatType: "p2p" | "group";
  messageId: string;
  senderId: string;
  senderType: string | null;
  senderIsBot: boolean | null;
  mentionedBot: boolean;
  /**
   * open ids of everyone the message @-mentioned.
   *
   * Carried explicitly rather than parsed out of `content`: the text form
   * differs by message type and can retain or drop the mention depending on how
   * it was sent. A message that mentions two bots is delivered once per bot, so
   * this is also how the full set of addressees is known from any one of those
   * deliveries — without it, a second addressee would be dropped as a duplicate.
   */
  mentionOpenIds: string[];
  /**
   * Files attached to the message, as the platform names them. The bytes are
   * fetched separately — they are not in the event, and pulling them is a
   * decision the router makes rather than something the transport does on every
   * message.
   */
  resources: Array<{ type: string; fileKey: string; fileName: string | null }>;
  content: string;
  threadId: string | null;
  createTime: number;
}

/**
 * Long-connection health for one bound agent, as the API reports it.
 *
 * Lives here rather than beside the connection module because the client reads
 * it: `src/server/channels/feishu/connection.ts` imports the platform SDK, and
 * a client file must never reach into that.
 */
export interface ChannelConnectionInfo {
  agentId: string;
  appId: string;
  status: ChannelConnectionStatus;
  botOpenId: string | null;
  botName: string | null;
  lastError: string | null;
  connectedAt: number | null;
}

/**
 * An external chat mapped to one AgentMeld conversation.
 *
 * One chat, one conversation, and one conversation, one chat — the inbound path
 * has no way to resolve an ambiguity, so neither direction may hold two.
 */
export interface ChannelConversation {
  id: string;
  channel: "feishu";
  chatId: string;
  conversationId: string;
  createdAt: number;
  updatedAt: number;
}

/**
 * A stored channel binding: one agent speaking through one external app
 * identity. Deliberately does NOT carry the app secret — that value never
 * leaves the server, and only `getChannelBindingSecret` in repositories.ts can
 * read it.
 */
export interface ChannelBinding {
  id: string;
  agentId: string;
  channel: "feishu";
  appId: string;
  tenantBrand: string | null;
  botOpenId: string | null;
  boundByOpenId: string | null;
  chatId: string | null;
  conversationId: string | null;
  createdAt: number;
  updatedAt: number;
}

/**
 * An in-flight binding attempt. The QR/launcher URL is present only on the
 * response that starts the attempt; it is deliberately kept out of the
 * broadcast event, because whoever holds that URL first can create the app.
 */
export interface ChannelBindingSession {
  id: string;
  agentId: string;
  status: ChannelBindingStatus;
  /**
   * When the launcher URL stops being usable, from the SDK's own `expireIn`.
   * `0` means unknown — a session the client learned about from a stream event
   * or a list rather than from the start response. Unknown is not the same as
   * expired, and the UI must not present it as such.
   */
  expiresAt: number;
  qrUrl?: string;
  error?: string;
  /**
   * Filled in by the client when a success event arrives, NOT by the server:
   * the session endpoints do not return these. A reload or another client
   * therefore loses them, which is why the UI can also resolve the app id from
   * the stored binding.
   */
  bindingId?: string;
  appId?: string;
}


export interface DeployStatusRecord {
  id: string;
  artifactId: string;
  outputKey?: string;
  title: string;
  version: number;
  previewPath: string;
  status: "ready" | "failed";
  sourceType?: "artifact" | "workspace";
  workspacePath?: string;
  deploymentType?: "local_static" | "external_static";
  deploymentPath?: string;
  localPreviewPath?: string;
  publicUrl?: string;
  publishPath?: string;
  publishTargetType?: "static_directory";
  sourceDownloadPath?: string;
  containerDownloadPath?: string;
  summaryInstruction?: string;
  error?: string;
  createdAt: number;
}

export interface DeployCandidateRecord {
  artifactId: string;
  title: string;
  version: number;
  createdByAgentId: string | null;
  createdAt: number;
}

export interface SearchHit {
  messageId: string;
  conversationId: string;
  conversationTitle: string;
  role: "user" | "agent" | "system";
  agentId: string | null;
  agentName: string | null;
  agentAvatar: string | null;
  createdAt: number;
  snippetHtml: string;
}

export type PartDelta =
  | { type: "text.append"; text: string }
  | { type: "code.append"; text: string }
  | { type: "thinking.append"; text: string };

export interface ToolArgumentRepairMetadata {
  applied: boolean;
  kinds: string[];
}

export type MessagePart =
  | { type: "text"; content: string }
  | { type: "thinking"; content: string }
  | { type: "code"; language?: string; content: string }
  | { type: "tool_use"; callId: string; toolName: string; args: unknown; argumentRepair?: ToolArgumentRepairMetadata }
  | { type: "tool_result"; callId: string; result: unknown; isError?: boolean }
  | { type: "artifact_ref"; artifactId: string; title?: string; artifactType?: ArtifactType }
  | { type: "deploy_status"; deployment: DeployStatusRecord }
  | { type: "deploy_candidates"; candidates: DeployCandidateRecord[] }
  | { type: "image_attachment"; attachmentId: string; fileName: string; size: number; mimeType: string }
  | { type: "file_attachment"; attachmentId: string; fileName: string; size: number; mimeType: string };

export type ArtifactType = "web_app" | "code_file" | "diff" | "document" | "image" | "ppt";

export interface DiffHunk {
  oldStart?: number;
  oldLines?: number;
  newStart?: number;
  newLines?: number;
  header?: string;
  lines: string[];
}

export interface PptTheme {
  primary?: string;
  background?: string;
  surface?: string;
  textBody?: string;
  textMuted?: string;
  accentPositive?: string;
  accentNegative?: string;
  divider?: string;
  fontHeading?: string;
  fontBody?: string;
}

export interface PptBlock {
  type: "heading" | "paragraph" | "bullets" | "metric" | "quote" | "timeline" | "columns" | "callout" | "divider" | "spacer";
  [key: string]: unknown;
}

export interface PptSlide {
  title?: string;
  subtitle?: string;
  bullets?: string[];
  blocks?: PptBlock[];
  notes?: string;
  layout?:
    | "title"
    | "title-bullets"
    | "section"
    | "blank"
    | "content"
    | "two-column"
    | "metrics"
    | "timeline"
    | "quote";
}

export type ArtifactContent =
  | { type: "document"; format?: "markdown"; content: string }
  | { type: "web_app"; files: Record<string, string>; entry: string; deploymentPreviewPath?: string; sourceType?: "artifact" | "workspace" }
  | { type: "image"; url: string; alt?: string; width?: number; height?: number }
  | { type: "code_file"; workspacePath: string; language?: string; sizeBytes?: number; checksum?: string }
  | { type: "diff"; targetArtifactId: string; hunks: DiffHunk[]; applied: boolean }
  | { type: "ppt"; title?: string; theme?: PptTheme; slides: PptSlide[] };

export interface Agent {
  id: string;
  name: string;
  avatar: string;
  description: string;
  capabilities: string[];
  adapterName: AdapterName;
  modelProvider: ModelProvider | null;
  modelId: string | null;
  apiKey: string | null;
  apiBaseUrl: string | null;
  systemPrompt: string;
  toolNames: string[];
  isBuiltin: boolean;
  isConductor: boolean;
  supportsVision: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface Conversation {
  id: string;
  title: string;
  mode: ConversationMode;
  agentIds: string[];
  fsWriteApprovalMode: FsWriteApprovalMode;
  pinnedMessageIds: string[];
  archived: boolean;
  pinnedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface Message {
  id: string;
  /** Transport correlation, persisted in message_submissions rather than message content. */
  clientRequestId?: string;
  conversationId: string;
  role: MessageRole;
  origin: MessageOrigin;
  agentId: string | null;
  runId: string | null;
  parts: MessagePart[];
  status: MessageStatus;
  mentionedAgentIds: string[];
  parentMessageId: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface Artifact {
  id: string;
  conversationId: string;
  createdByAgentId: string | null;
  type: ArtifactType;
  title: string;
  content: ArtifactContent;
  version: number;
  parentArtifactId: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface Workspace {
  id: string;
  conversationId: string;
  mode: WorkspaceMode;
  rootPath: string;
  boundPath: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface Attachment {
  id: string;
  conversationId: string;
  kind: AttachmentKind;
  fileName: string;
  filePath: string;
  size: number;
  mimeType: string;
  createdAt: number;
}

export interface AgentRun {
  id: string;
  conversationId: string;
  agentId: string;
  triggerMessageId: string | null;
  parentRunId: string | null;
  status: AgentRunStatus;
  stage: string | null;
  error: string | null;
  usage: UsagePayload | null;
  interrupted: boolean;
  errorCategory: string | null;
  retryable: boolean;
  startedAt: number;
  finishedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface ConductorTaskRecord {
  id: string;
  conductorRunId: string;
  conversationId: string;
  taskId: string;
  agentId: string;
  title: string | null;
  status: string;
  summary: string | null;
  childRunId: string | null;
  attempt: number;
  errorCategory: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface ConversationContextSummary {
  id: string;
  conversationId: string;
  summary: string;
  coveredUntilMessageId: string;
  coveredUntilCreatedAt: number;
  sourceMessageCount: number;
  tokenEstimate: number;
  modelProvider: ModelProvider | null;
  modelId: string | null;
  createdAt: number;
}

export interface AppSettings {
  id: "singleton";
  anthropicApiKey: string | null;
  anthropicBaseUrl: string | null;
  openaiApiKey: string | null;
  deepseekApiKey: string | null;
  arkApiKey: string | null;
  companionMode: CompanionMode;
  mobileDeviceToken: string | null;
  deploymentPublishEnabled: boolean;
  deploymentPublishDir: string | null;
  deploymentPublicBaseUrl: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface UsagePayload {
  modelId?: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  lastInputTokens?: number;
  model?: string;
}

export interface PendingWrite {
  id: string;
  conversationId: string;
  agentId: string;
  runId: string;
  path: string;
  absolutePath: string;
  oldContent: string | null;
  newContent: string;
  createdAt: number;
}

export interface PendingBashCommand {
  id: string;
  conversationId: string;
  agentId: string;
  runId: string;
  command: string;
  cwd: string;
  reason: string;
  createdAt: number;
}

export interface PendingQuestion {
  id: string;
  conversationId: string;
  agentId: string;
  runId: string;
  questions: Array<{
    question: string;
    header: string;
    options: Array<{ label: string; description?: string }>;
    multiSelect?: boolean;
  }>;
  createdAt: number;
}

/** P4: Structured acceptance criterion with machine-verifiable validator */
export interface AcceptanceCriterionSpec {
  id: string;
  description: string;
  required: boolean;
  validator: import("@/shared/evidence-types").CriterionValidator;
}

export type DispatchTaskIntent =
  | "delivery"
  | "diagnosis"
  | "verification"
  | "approval_probe"
  | "negative_verifier_test";

export interface DispatchPlanItem {
  id: string;
  agentId: string;
  task: string;
  dependsOn: string[];
  title?: string;
  prompt?: string;
  inputs?: Array<{ fromTaskId: string; outputId: string; required?: boolean; description?: string }>;
  expectedOutputs?: Array<{ id: string; type: "web_app" | "document" | "image" | "ppt"; required?: boolean; description?: string }>;
  acceptanceCriteria?: string[];
  maxAttempts?: number;
  targetPaths?: string[];
  requiredCommands?: Array<{ command: string; timeoutMs?: number }>;
  requiredEvidence?: string[];
  /** Proposed by Conductor and deterministically reconciled by the platform. */
  taskIntent?: DispatchTaskIntent;
  /** System-selected contract profile; never trusted as an LLM bypass flag. */
  contractProfile?: "standard" | "minimal";
  /** Deterministic explanation for the selected contract profile. */
  contractSelectionReason?: string;
  /** Version of the deterministic contract-selection policy. */
  contractSelectionVersion?: string;
}

export interface PendingDispatchPlan {
  id: string;
  conversationId: string;
  runId: string;
  plan: DispatchPlanItem[];
  createdAt: number;
}

interface BaseEvent {
  conversationId: string;
  timestamp: number;
}

export type StreamEvent =
  | (BaseEvent & { type: "heartbeat" })
  | (BaseEvent & {
      type: "run.start";
      runId: string;
      agentId: string;
      triggerMessageId: string | null;
      parentRunId?: string | null;
    })
  | (BaseEvent & { type: "run.end"; runId: string; status: AgentRunStatus; error?: string })
  | (BaseEvent & { type: "collaboration.consultation"; consultation: AgentConsultation })
  | (BaseEvent & { type: "collaboration.turn"; turn: CollaborationTurn })
  | (BaseEvent & { type: "collaboration.handoff"; handoff: TaskHandoff })
  | (BaseEvent & { type: "run.stage"; runId: string; stage: string })
  | (BaseEvent & { type: "run.usage"; runId: string; usage: UsagePayload })
  | (BaseEvent & { type: "message.added"; message: Message })
  | (BaseEvent & { type: "message.removed"; messageIds: string[]; artifactIds: string[] })
  | (BaseEvent & { type: "message.start"; messageId: string; agentId: string; runId: string })
  | (BaseEvent & { type: "message.end"; messageId: string; status?: MessageStatus })
  | (BaseEvent & { type: "message.usage"; messageId: string; usage: UsagePayload })
  | (BaseEvent & {
      type: "part.start";
      messageId: string;
      partIndex: number;
      part: MessagePart;
    })
  | (BaseEvent & {
      type: "part.delta";
      messageId: string;
      partIndex: number;
      delta: PartDelta;
    })
  | (BaseEvent & { type: "part.end"; messageId: string; partIndex: number })
  | (BaseEvent & {
      type: "tool.call";
      messageId: string;
      callId: string;
      toolName: string;
      args: unknown;
      argumentRepair?: ToolArgumentRepairMetadata;
    })
  | (BaseEvent & {
      type: "tool.result";
      messageId: string;
      callId: string;
      result: unknown;
      isError?: boolean;
    })
  | (BaseEvent & { type: "artifact.create"; artifact: Artifact })
  | (BaseEvent & { type: "artifact.update"; artifactId: string; patch: Partial<ArtifactContent> })
  | (BaseEvent & { type: "deploy.status"; messageId: string; deployment: DeployStatusRecord })
  | (BaseEvent & { type: "dispatch.plan"; runId: string; plan: DispatchPlanItem[] })
  | (BaseEvent & { type: "dispatch.plan.pending"; pendingPlan: PendingDispatchPlan })
  | (BaseEvent & { type: "dispatch.plan.resolved"; pendingId: string; runId: string; approved: boolean; feedback?: string })
  | (BaseEvent & { type: "dispatch.start"; parentRunId: string; childRunId: string; taskId: string; agentId: string })
  | (BaseEvent & {
      type: "dispatch.task.start";
      parentRunId: string;
      childRunId: string;
      taskId: string;
      agentId: string;
      attempt: number;
    })
  | (BaseEvent & {
      type: "dispatch.task.end";
      parentRunId: string;
      childRunId: string;
      taskId: string;
      agentId: string;
      status: "complete" | "failed" | "aborted" | "skipped" | "blocked";
      error?: string;
    })
  | (BaseEvent & {
      type: "dispatch.end";
      parentRunId: string;
      childRunId?: string;
      taskId: string;
      status: "complete" | "failed" | "aborted" | "skipped";
      error?: string;
    })
  | (BaseEvent & { type: "fs_write.pending"; pendingWrite: PendingWrite })
  | (BaseEvent & { type: "fs_write.resolved"; pendingId: string; applied: boolean })
  | (BaseEvent & { type: "bash_command.pending"; pendingCommand: PendingBashCommand })
  | (BaseEvent & { type: "bash_command.resolved"; pendingId: string; approved: boolean })
  | (BaseEvent & { type: "ask_user.pending"; pendingQuestion: PendingQuestion })
  | (BaseEvent & { type: "ask_user.answered"; pendingId: string; answers: Record<string, string> })
  | (BaseEvent & { type: "ask_user.cancelled"; pendingId: string; runId: string })
  | (BaseEvent & {
      type: "compaction.start";
      sourceMessageCount: number;
    })
  | (BaseEvent & {
      type: "compaction.progress";
      stage: "reading" | "summarizing" | "storing";
      detail?: string;
    })
  | (BaseEvent & {
      type: "compaction.end";
      sourceMessageCount: number;
      coveredUntilMessageId: string;
      summary: string;
      tokenEstimate: number;
    })
  | (BaseEvent & {
      type: "compaction.error";
      error: string;
    })
  // ── P7: Evidence-aware context observability events ──────────────────────
  | (BaseEvent & {
      type: "dispatch.context.compiled";
      parentRunId: string;
      taskId: string;
      attemptId: string;
      contextSnapshotId: string;
      includedCount: number;
      omittedCount: number;
      tokenEstimate: number;
      agentId: string;
    })
  | (BaseEvent & {
      type: "dispatch.verification.updated";
      parentRunId: string;
      taskId: string;
      attemptId: string;
      status: "checking" | "verified" | "rejected" | "needs_review";
      passedCount: number;
      failedCount: number;
    })
  | (BaseEvent & {
      type: "dispatch.evidence.summary";
      parentRunId: string;
      taskId: string;
      attemptId: string;
      childRunId: string;
      evidenceCount: number;
    })
  // ── Channel bindings ─────────────────────────────────────────────────────
  | (BaseEvent & {
      type: "channel.binding.updated";
      /** The attempt. Always present. */
      sessionId: string;
      agentId: string;
      status: ChannelBindingStatus;
      /** The persisted row, present only once the scan succeeded. */
      bindingId?: string;
      appId?: string;
      error?: string;
    })
  // ── Channel connections ──────────────────────────────────────────────────
  // Neither of these belongs to a conversation, so `conversationId` is empty —
  // the same convention `channel.binding.updated` uses.
  | (BaseEvent & {
      type: "channel.inbound";
      message: ChannelInboundMessage;
    })
  | (BaseEvent & {
      type: "channel.connection";
      agentId: string;
      appId: string;
      status: ChannelConnectionStatus;
      /**
       * For `rejected:*` and `error`: why. A `rejected:bot_loop` here is how we
       * can tell §5.8's transport-level guard actually tripped.
       */
      reason?: string;
    });
