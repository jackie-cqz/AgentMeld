export type AdapterName = "claude-code" | "codex" | "custom" | "mock";

export type ModelProvider =
  | "anthropic"
  | "openai"
  | "deepseek"
  | "volcano-ark"
  | "openai-compatible";

export type ConversationMode = "single" | "group";
export type MessageRole = "user" | "agent" | "system";
export type MessageStatus = "streaming" | "complete" | "error" | "aborted";
export type AgentRunStatus = "queued" | "running" | "complete" | "failed" | "aborted";
export type FsWriteApprovalMode = "auto" | "review";
export type WorkspaceMode = "sandbox" | "local";
export type AttachmentKind = "image" | "file";
export type CompanionMode = "off" | "lan" | "tailnet";

export interface DeployStatusRecord {
  id: string;
  artifactId: string;
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

export type MessagePart =
  | { type: "text"; content: string }
  | { type: "thinking"; content: string }
  | { type: "code"; language?: string; content: string }
  | { type: "tool_use"; callId: string; toolName: string; args: unknown }
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
  conversationId: string;
  role: MessageRole;
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
    });
