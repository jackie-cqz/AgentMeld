import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import type {
  AdapterName,
  AgentRunStatus,
  ArtifactContent,
  ArtifactType,
  AttachmentKind,
  CompanionMode,
  ConversationMode,
  FsWriteApprovalMode,
  MessagePart,
  MessageRole,
  MessageStatus,
  ModelProvider,
  UsagePayload,
  WorkspaceMode
} from "@/shared/types";

export const agents = sqliteTable("agents", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  avatar: text("avatar").notNull(),
  description: text("description").notNull(),
  capabilities: text("capabilities", { mode: "json" }).$type<string[]>().notNull(),
  systemPrompt: text("system_prompt").notNull(),
  adapterName: text("adapter_name").$type<AdapterName>().notNull(),
  modelProvider: text("model_provider").$type<ModelProvider>(),
  modelId: text("model_id"),
  apiKey: text("api_key"),
  apiBaseUrl: text("api_base_url"),
  toolNames: text("tool_names", { mode: "json" }).$type<string[]>().notNull(),
  isBuiltin: integer("is_builtin", { mode: "boolean" }).notNull().default(false),
  isOrchestrator: integer("is_orchestrator", { mode: "boolean" }).notNull().default(false),
  supportsVision: integer("supports_vision", { mode: "boolean" }).notNull().default(false),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull()
});

export const conversations = sqliteTable(
  "conversations",
  {
    id: text("id").primaryKey(),
    title: text("title").notNull(),
    mode: text("mode").$type<ConversationMode>().notNull(),
    agentIds: text("agent_ids", { mode: "json" }).$type<string[]>().notNull(),
    pinnedMessageIds: text("pinned_message_ids", { mode: "json" }).$type<string[]>().notNull(),
    archived: integer("archived", { mode: "boolean" }).notNull().default(false),
    fsWriteApprovalMode: text("fs_write_approval_mode").$type<FsWriteApprovalMode>().notNull().default("review"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull()
  },
  (table) => [index("idx_conv_updated").on(table.updatedAt)]
);

export const messages = sqliteTable(
  "messages",
  {
    id: text("id").primaryKey(),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    role: text("role").$type<MessageRole>().notNull(),
    agentId: text("agent_id").references(() => agents.id),
    runId: text("run_id"),
    parts: text("parts", { mode: "json" }).$type<MessagePart[]>().notNull(),
    status: text("status").$type<MessageStatus>().notNull(),
    mentionedAgentIds: text("mentioned_agent_ids", { mode: "json" }).$type<string[]>().notNull(),
    parentMessageId: text("parent_message_id"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull()
  },
  (table) => [index("idx_messages_conv_created").on(table.conversationId, table.createdAt)]
);

export const artifacts = sqliteTable(
  "artifacts",
  {
    id: text("id").primaryKey(),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    createdByAgentId: text("created_by_agent_id").references(() => agents.id),
    type: text("type").$type<ArtifactType>().notNull(),
    title: text("title").notNull(),
    content: text("content", { mode: "json" }).$type<ArtifactContent>().notNull(),
    version: integer("version").notNull().default(1),
    parentArtifactId: text("parent_artifact_id"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull()
  },
  (table) => [index("idx_artifacts_conv").on(table.conversationId)]
);

export const workspaces = sqliteTable(
  "workspaces",
  {
    id: text("id").primaryKey(),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    mode: text("mode").$type<WorkspaceMode>().notNull().default("sandbox"),
    rootPath: text("root_path").notNull(),
    boundPath: text("bound_path"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull()
  },
  (table) => [uniqueIndex("idx_workspaces_conversation_unique").on(table.conversationId)]
);

export const attachments = sqliteTable(
  "attachments",
  {
    id: text("id").primaryKey(),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    kind: text("kind").$type<AttachmentKind>().notNull(),
    fileName: text("file_name").notNull(),
    filePath: text("file_path").notNull(),
    size: integer("size").notNull(),
    mimeType: text("mime_type").notNull(),
    createdAt: integer("created_at").notNull()
  },
  (table) => [index("idx_attachments_conv").on(table.conversationId)]
);

export const agentRuns = sqliteTable(
  "agent_runs",
  {
    id: text("id").primaryKey(),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id),
    triggerMessageId: text("trigger_message_id"),
    parentRunId: text("parent_run_id"),
    status: text("status").$type<AgentRunStatus>().notNull(),
    error: text("error"),
    usage: text("usage", { mode: "json" }).$type<UsagePayload>(),
    startedAt: integer("started_at").notNull(),
    finishedAt: integer("finished_at"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull()
  },
  (table) => [index("idx_runs_parent").on(table.parentRunId)]
);

export const conversationContextSummaries = sqliteTable(
  "conversation_context_summaries",
  {
    id: text("id").primaryKey(),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    summary: text("summary").notNull(),
    coveredUntilMessageId: text("covered_until_message_id").notNull(),
    coveredUntilCreatedAt: integer("covered_until_created_at").notNull(),
    sourceMessageCount: integer("source_message_count").notNull(),
    tokenEstimate: integer("token_estimate").notNull(),
    modelProvider: text("model_provider").$type<ModelProvider>(),
    modelId: text("model_id"),
    createdAt: integer("created_at").notNull()
  },
  (table) => [index("idx_context_summaries_conv_created").on(table.conversationId, table.createdAt)]
);

export const appSettings = sqliteTable("app_settings", {
  id: text("id").primaryKey().$type<"singleton">(),
  anthropicApiKey: text("anthropic_api_key"),
  anthropicBaseUrl: text("anthropic_base_url"),
  openaiApiKey: text("openai_api_key"),
  deepseekApiKey: text("deepseek_api_key"),
  arkApiKey: text("ark_api_key"),
  companionMode: text("companion_mode").$type<CompanionMode>().notNull().default("off"),
  mobileDeviceToken: text("mobile_device_token"),
  deploymentPublishEnabled: integer("deployment_publish_enabled", { mode: "boolean" }).notNull().default(false),
  deploymentPublishDir: text("deployment_publish_dir"),
  deploymentPublicBaseUrl: text("deployment_public_base_url"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull()
});
