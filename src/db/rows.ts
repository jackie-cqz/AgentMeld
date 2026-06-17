import type {
  Agent,
  AgentRun,
  AppSettings,
  Artifact,
  ArtifactContent,
  Attachment,
  Conversation,
  ConversationContextSummary,
  Message,
  MessagePart,
  UsagePayload,
  Workspace
} from "@/shared/types";

export interface AgentRow {
  id: string;
  name: string;
  avatar?: string | null;
  description: string | null;
  capabilities?: string | null;
  adapter_name: string;
  model_provider: string | null;
  model_id: string | null;
  api_key?: string | null;
  api_base_url?: string | null;
  system_prompt: string;
  tool_names: string;
  is_builtin: number;
  is_orchestrator: number;
  supports_vision?: number | null;
  created_at: number;
  updated_at: number;
}

export interface ConversationRow {
  id: string;
  title: string;
  mode: string;
  agent_ids: string;
  fs_write_approval_mode: string;
  pinned_message_ids: string;
  archived?: number | null;
  created_at: number;
  updated_at: number;
}

export interface MessageRow {
  id: string;
  conversation_id: string;
  role: string;
  agent_id: string | null;
  run_id: string | null;
  parts: string;
  status: string;
  mentioned_agent_ids: string;
  parent_message_id: string | null;
  created_at: number;
  updated_at: number;
}

export interface AgentRunRow {
  id: string;
  conversation_id: string;
  agent_id: string;
  trigger_message_id: string | null;
  parent_run_id: string | null;
  status: string;
  error?: string | null;
  usage: string | null;
  started_at?: number | null;
  finished_at?: number | null;
  created_at: number;
  updated_at: number;
}

export interface ArtifactRow {
  id: string;
  conversation_id: string;
  created_by_agent_id: string | null;
  type: string;
  title: string;
  content: string;
  version: number;
  parent_artifact_id: string | null;
  created_at: number;
  updated_at: number;
}

export interface WorkspaceRow {
  id: string;
  conversation_id: string;
  mode: string;
  root_path: string;
  bound_path: string | null;
  created_at: number;
  updated_at: number;
}

export interface AttachmentRow {
  id: string;
  conversation_id: string;
  kind: string;
  file_name: string;
  file_path: string;
  size: number;
  mime_type: string;
  created_at: number;
}

export interface ConversationContextSummaryRow {
  id: string;
  conversation_id: string;
  summary: string;
  covered_until_message_id: string;
  covered_until_created_at: number;
  source_message_count: number;
  token_estimate: number;
  model_provider: string | null;
  model_id: string | null;
  created_at: number;
}

export interface AppSettingsRow {
  id: "singleton";
  anthropic_api_key: string | null;
  anthropic_base_url: string | null;
  openai_api_key: string | null;
  deepseek_api_key: string | null;
  ark_api_key: string | null;
  companion_mode: string;
  mobile_device_token: string | null;
  deployment_publish_enabled: number;
  deployment_publish_dir: string | null;
  deployment_public_base_url: string | null;
  created_at: number;
  updated_at: number;
}

function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export function mapAgent(row: AgentRow): Agent {
  return {
    id: row.id,
    name: row.name,
    avatar: row.avatar ?? "🤖",
    description: row.description ?? "",
    capabilities: parseJson<string[]>(row.capabilities, []),
    adapterName: row.adapter_name as Agent["adapterName"],
    modelProvider: row.model_provider as Agent["modelProvider"],
    modelId: row.model_id,
    apiKey: row.api_key ?? null,
    apiBaseUrl: row.api_base_url ?? null,
    systemPrompt: row.system_prompt,
    toolNames: parseJson<string[]>(row.tool_names, []),
    isBuiltin: row.is_builtin === 1,
    isOrchestrator: row.is_orchestrator === 1,
    supportsVision: row.supports_vision === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export function mapConversation(row: ConversationRow): Conversation {
  return {
    id: row.id,
    title: row.title,
    mode: row.mode as Conversation["mode"],
    agentIds: parseJson<string[]>(row.agent_ids, []),
    fsWriteApprovalMode: row.fs_write_approval_mode as Conversation["fsWriteApprovalMode"],
    pinnedMessageIds: parseJson<string[]>(row.pinned_message_ids, []),
    archived: row.archived === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export function mapMessage(row: MessageRow): Message {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    role: row.role as Message["role"],
    agentId: row.agent_id,
    runId: row.run_id,
    parts: parseJson<MessagePart[]>(row.parts, []),
    status: row.status as Message["status"],
    mentionedAgentIds: parseJson<string[]>(row.mentioned_agent_ids, []),
    parentMessageId: row.parent_message_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export function mapRun(row: AgentRunRow): AgentRun {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    agentId: row.agent_id,
    triggerMessageId: row.trigger_message_id,
    parentRunId: row.parent_run_id,
    status: row.status as AgentRun["status"],
    error: row.error ?? null,
    usage: row.usage ? parseJson<UsagePayload | null>(row.usage, null) : null,
    startedAt: row.started_at ?? row.created_at,
    finishedAt: row.finished_at ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export function mapArtifact(row: ArtifactRow): Artifact {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    createdByAgentId: row.created_by_agent_id,
    type: row.type as Artifact["type"],
    title: row.title,
    content: parseJson<ArtifactContent>(row.content, { type: "document", format: "markdown", content: "" }),
    version: row.version,
    parentArtifactId: row.parent_artifact_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export function mapWorkspace(row: WorkspaceRow): Workspace {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    mode: row.mode as Workspace["mode"],
    rootPath: row.root_path,
    boundPath: row.bound_path,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export function mapAttachment(row: AttachmentRow): Attachment {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    kind: row.kind as Attachment["kind"],
    fileName: row.file_name,
    filePath: row.file_path,
    size: row.size,
    mimeType: row.mime_type,
    createdAt: row.created_at
  };
}

export function mapContextSummary(row: ConversationContextSummaryRow): ConversationContextSummary {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    summary: row.summary,
    coveredUntilMessageId: row.covered_until_message_id,
    coveredUntilCreatedAt: row.covered_until_created_at,
    sourceMessageCount: row.source_message_count,
    tokenEstimate: row.token_estimate,
    modelProvider: row.model_provider as ConversationContextSummary["modelProvider"],
    modelId: row.model_id,
    createdAt: row.created_at
  };
}

export function mapAppSettings(row: AppSettingsRow): AppSettings {
  return {
    id: row.id,
    anthropicApiKey: row.anthropic_api_key,
    anthropicBaseUrl: row.anthropic_base_url,
    openaiApiKey: row.openai_api_key,
    deepseekApiKey: row.deepseek_api_key,
    arkApiKey: row.ark_api_key,
    companionMode: row.companion_mode as AppSettings["companionMode"],
    mobileDeviceToken: row.mobile_device_token,
    deploymentPublishEnabled: row.deployment_publish_enabled === 1,
    deploymentPublishDir: row.deployment_publish_dir,
    deploymentPublicBaseUrl: row.deployment_public_base_url,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}
