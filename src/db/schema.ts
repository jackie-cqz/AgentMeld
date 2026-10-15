import { sql } from "drizzle-orm";
import { index, integer, primaryKey, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
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
  MessageOrigin,
  MessageRole,
  MessageStatus,
  ModelProvider,
  UsagePayload,
  WorkspaceMode
} from "@/shared/types";

export const modelProviderProfiles = sqliteTable("model_provider_profiles", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  presetId: text("preset_id"),
  protocol: text("protocol").$type<"chat-completions">().notNull().default("chat-completions"),
  baseUrl: text("base_url").notNull(),
  defaultModel: text("default_model").notNull(),
  models: text("models", { mode: "json" }).$type<string[]>().notNull(),
  apiKey: text("api_key"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull()
});

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
  isConductor: integer("is_conductor", { mode: "boolean" }).notNull().default(false),
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
    updatedAt: integer("updated_at").notNull(),
    // Added to existing databases by bootstrap's createIndexes() ALTER path.
    pinnedAt: integer("pinned_at")
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
    origin: text("origin").$type<MessageOrigin>().notNull().default("human"),
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
    // stage / interrupted / error_category / retryable are added to existing
    // databases by bootstrap's createIndexes() ALTER path.
    stage: text("stage"),
    error: text("error"),
    usage: text("usage", { mode: "json" }).$type<UsagePayload>(),
    interrupted: integer("interrupted", { mode: "boolean" }).notNull().default(false),
    errorCategory: text("error_category"),
    retryable: integer("retryable", { mode: "boolean" }).notNull().default(false),
    startedAt: integer("started_at").notNull(),
    finishedAt: integer("finished_at"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull()
  },
  (table) => [index("idx_runs_parent").on(table.parentRunId)]
);

// ── Conductor, approval and compaction runtime tables ──────────────────────

export const conductorTaskResults = sqliteTable(
  "conductor_task_results",
  {
    id: text("id").primaryKey(),
    conductorRunId: text("conductor_run_id")
      .notNull()
      .references(() => agentRuns.id, { onDelete: "cascade" }),
    conversationId: text("conversation_id").notNull(),
    taskId: text("task_id").notNull(),
    agentId: text("agent_id").notNull(),
    title: text("title"),
    status: text("status").notNull(),
    summary: text("summary"),
    childRunId: text("child_run_id"),
    attempt: integer("attempt").notNull().default(1),
    errorCategory: text("error_category"),
    verificationStatus: text("verification_status").notNull().default("not_started"),
    verifiedAttemptId: text("verified_attempt_id"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull()
  },
  (table) => [index("idx_cond_task_results_run").on(table.conductorRunId)]
);

export const pendingApprovals = sqliteTable(
  "pending_approvals",
  {
    id: text("id").primaryKey(),
    conversationId: text("conversation_id").notNull(),
    agentId: text("agent_id").notNull(),
    runId: text("run_id").notNull(),
    approvalType: text("approval_type").notNull(),
    status: text("status").notNull().default("pending"),
    payloadJson: text("payload_json", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
    resolvedBy: text("resolved_by"),
    // Caller-declared display label. Never identity: `resolvedBy` above is the
    // authenticated principal (#24), this is whatever string the caller sent.
    resolvedByLabel: text("resolved_by_label"),
    resolvedAt: integer("resolved_at"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull()
  },
  (table) => [
    index("idx_pending_approvals_conv").on(table.conversationId, table.status),
    index("idx_pending_approvals_run").on(table.runId)
  ]
);

/**
 * One-time grants that authorize a child run (#24 trusted delegation).
 *
 * `correlation_id` holds a HASH: the value itself is a bearer capability and
 * is only ever returned once, to the caller that minted it.
 */
export const delegations = sqliteTable(
  "delegations",
  {
    id: text("id").primaryKey(),
    correlationId: text("correlation_id").notNull(),
    sourceRunId: text("source_run_id").notNull(),
    sourceAgentId: text("source_agent_id").notNull(),
    targetAgentId: text("target_agent_id").notNull(),
    taskId: text("task_id").notNull(),
    attempt: integer("attempt").notNull(),
    status: text("status").notNull().default("issued"),
    issuedAt: integer("issued_at").notNull(),
    expiresAt: integer("expires_at").notNull(),
    consumedAt: integer("consumed_at"),
    consumedByRunId: text("consumed_by_run_id")
  },
  (table) => [
    uniqueIndex("idx_delegations_correlation").on(table.correlationId),
    index("idx_delegations_source_run").on(table.sourceRunId, table.status)
  ]
);

export const conductorPlans = sqliteTable(
  "conductor_plans",
  {
    id: text("id").primaryKey(),
    conductorRunId: text("conductor_run_id")
      .notNull()
      .references(() => agentRuns.id, { onDelete: "cascade" }),
    conversationId: text("conversation_id").notNull(),
    revision: integer("revision").notNull().default(0),
    planJson: text("plan_json", { mode: "json" }).$type<unknown>().notNull(),
    status: text("status").notNull().default("pending"),
    userFeedback: text("user_feedback"),
    stageAtCreation: text("stage_at_creation"),
    resumedFromRunId: text("resumed_from_run_id"),
    createdAt: integer("created_at").notNull(),
    resolvedAt: integer("resolved_at")
  },
  (table) => [index("idx_cond_plans_run").on(table.conductorRunId)]
);

export const conductorOutputBindings = sqliteTable(
  "conductor_output_bindings",
  {
    conductorRunId: text("conductor_run_id").notNull(),
    planId: text("plan_id").notNull(),
    producerTaskId: text("producer_task_id").notNull(),
    outputKey: text("output_key").notNull(),
    artifactId: text("artifact_id").notNull(),
    createdAt: integer("created_at").notNull(),
    supersededAt: integer("superseded_at"),
    replacedByTaskId: text("replaced_by_task_id"),
    actualProducerTaskId: text("actual_producer_task_id")
  },
  (table) => [
    primaryKey({ columns: [table.planId, table.producerTaskId, table.outputKey] }),
    index("idx_cond_bindings_plan").on(table.planId)
  ]
);

export const conductorConflicts = sqliteTable(
  "conductor_conflicts",
  {
    id: text("id").primaryKey(),
    conductorRunId: text("conductor_run_id")
      .notNull()
      .references(() => agentRuns.id, { onDelete: "cascade" }),
    planId: text("plan_id").notNull(),
    path: text("path").notNull(),
    wave: integer("wave").notNull(),
    contributorsJson: text("contributors_json", { mode: "json" }).$type<unknown>().notNull(),
    status: text("status").notNull().default("detected"),
    createdAt: integer("created_at").notNull()
  },
  (table) => [index("idx_cond_conflicts_run").on(table.conductorRunId)]
);

export const contextCompactionJobs = sqliteTable(
  "context_compaction_jobs",
  {
    id: text("id").primaryKey(),
    conversationId: text("conversation_id").notNull(),
    status: text("status").notNull().default("queued"),
    baseSummaryId: text("base_summary_id"),
    // Added to existing databases by bootstrap's createIndexes() ensureColumn path.
    previousJobId: text("previous_job_id"),
    resultSummaryId: text("result_summary_id"),
    sourceStartMessageId: text("source_start_message_id").notNull(),
    sourceEndMessageId: text("source_end_message_id").notNull(),
    sourceMessageCount: integer("source_message_count").notNull(),
    chunkCount: integer("chunk_count").notNull().default(0),
    completedChunkCount: integer("completed_chunk_count").notNull().default(0),
    modelProvider: text("model_provider").$type<ModelProvider>().notNull(),
    modelId: text("model_id").notNull(),
    attempt: integer("attempt").notNull().default(1),
    errorCategory: text("error_category"),
    error: text("error"),
    retryable: integer("retryable", { mode: "boolean" }).notNull().default(false),
    startedAt: integer("started_at"),
    finishedAt: integer("finished_at"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull()
  },
  (table) => [
    index("idx_compaction_jobs_conversation").on(table.conversationId, table.createdAt),
    index("idx_compaction_jobs_status").on(table.status, table.updatedAt),
    // Partial unique index: at most one queued/running job per conversation.
    uniqueIndex("idx_compaction_jobs_active")
      .on(table.conversationId)
      .where(sql`status IN ('queued', 'running')`)
  ]
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

// ── P1: Evidence-aware Context Engineering tables ──────────────────────────

export const taskAttempts = sqliteTable(
  "task_attempts",
  {
    id: text("id").primaryKey(),
    conductorRunId: text("conductor_run_id")
      .notNull()
      .references(() => agentRuns.id, { onDelete: "cascade" }),
    conversationId: text("conversation_id").notNull(),
    planId: text("plan_id").notNull(),
    planRevision: integer("plan_revision").notNull().default(0),
    taskId: text("task_id").notNull(),
    agentId: text("agent_id").notNull(),
    childRunId: text("child_run_id"),
    attempt: integer("attempt").notNull(),
    contextSnapshotId: text("context_snapshot_id"),
    executionStatus: text("execution_status").notNull().default("queued"),
    verificationStatus: text("verification_status").notNull().default("not_started"),
    failureContextJson: text("failure_context_json"),
    startedAt: integer("started_at"),
    finishedAt: integer("finished_at"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("idx_task_attempts_unique").on(
      table.conductorRunId, table.planId, table.taskId, table.attempt
    ),
    index("idx_task_attempts_run").on(table.conductorRunId, table.taskId),
  ]
);

export const taskContextSnapshots = sqliteTable(
  "task_context_snapshots",
  {
    id: text("id").primaryKey(),
    conversationId: text("conversation_id").notNull(),
    conductorRunId: text("conductor_run_id")
      .notNull()
      .references(() => agentRuns.id, { onDelete: "cascade" }),
    planId: text("plan_id").notNull(),
    taskId: text("task_id").notNull(),
    attemptId: text("attempt_id")
      .notNull()
      .references(() => taskAttempts.id, { onDelete: "cascade" }),
    policyVersion: text("policy_version").notNull(),
    schemaVersion: integer("schema_version").notNull(),
    envelopeJson: text("envelope_json").notNull(),
    manifestJson: text("manifest_json").notNull(),
    tokenEstimate: integer("token_estimate").notNull().default(0),
    requiredTokenEstimate: integer("required_token_estimate").notNull().default(0),
    omittedTokenEstimate: integer("omitted_token_estimate").notNull().default(0),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    index("idx_context_snapshots_attempt").on(table.attemptId),
  ]
);

export const taskEvidence = sqliteTable(
  "task_evidence",
  {
    id: text("id").primaryKey(),
    conversationId: text("conversation_id").notNull(),
    conductorRunId: text("conductor_run_id")
      .notNull()
      .references(() => agentRuns.id, { onDelete: "cascade" }),
    planId: text("plan_id").notNull(),
    taskId: text("task_id").notNull(),
    attemptId: text("attempt_id")
      .notNull()
      .references(() => taskAttempts.id, { onDelete: "cascade" }),
    childRunId: text("child_run_id")
      .notNull()
      .references(() => agentRuns.id, { onDelete: "cascade" }),
    contextSnapshotId: text("context_snapshot_id").notNull(),
    agentId: text("agent_id").notNull(),
    type: text("type").notNull(),
    status: text("status").notNull().default("valid"),
    trustLevel: text("trust_level").notNull().default("verified"),
    sourceKind: text("source_kind").notNull(),
    sourceId: text("source_id").notNull(),
    subjectType: text("subject_type").notNull(),
    subjectId: text("subject_id").notNull(),
    payloadJson: text("payload_json").notNull(),
    contentHash: text("content_hash"),
    invalidatedAt: integer("invalidated_at"),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    index("idx_task_evidence_attempt").on(table.attemptId, table.createdAt),
    index("idx_task_evidence_subject").on(table.subjectType, table.subjectId, table.status),
    index("idx_task_evidence_task").on(table.conductorRunId, table.planId, table.taskId),
  ]
);

export const criterionVerdicts = sqliteTable(
  "criterion_verdicts",
  {
    id: text("id").primaryKey(),
    attemptId: text("attempt_id")
      .notNull()
      .references(() => taskAttempts.id, { onDelete: "cascade" }),
    criterionId: text("criterion_id").notNull(),
    validatorType: text("validator_type").notNull(),
    status: text("status").notNull(),
    evidenceIdsJson: text("evidence_ids_json").notNull().default("[]"),
    reason: text("reason").notNull(),
    checkedAt: integer("checked_at").notNull(),
  },
  (table) => [
    uniqueIndex("idx_criterion_verdicts_unique").on(table.attemptId, table.criterionId),
  ]
);

// ── P2: Fact Registry tables ───────────────────────────────────────────────

export const conversationFactDefinitions = sqliteTable(
  "conversation_fact_definitions",
  {
    id: text("id").primaryKey(),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    canonicalKey: text("canonical_key").notNull(),
    namespace: text("namespace").notNull(),
    entityType: text("entity_type").notNull(),
    propertyName: text("property_name").notNull(),
    valueType: text("value_type").notNull(),
    updatePolicy: text("update_policy").notNull().default("replace"),
    description: text("description").notNull(),
    aliasesJson: text("aliases_json", { mode: "json" }).$type<string[]>().notNull().default([]),
    applicableTaskTagsJson: text("applicable_task_tags_json", { mode: "json" }).$type<string[]>().notNull().default([]),
    applicableAgentRolesJson: text("applicable_agent_roles_json", { mode: "json" }).$type<string[]>().notNull().default([]),
    status: text("status").notNull().default("active"),
    origin: text("origin").notNull().default("conversation"),
    proposedByAgentId: text("proposed_by_agent_id"),
    sourceMessageId: text("source_message_id"),
    mergedIntoDefinitionId: text("merged_into_definition_id"),
    // Added after the initial P2 schema via bootstrap's ALTER TABLE path.
    valueJson: text("value_json", { mode: "json" }).$type<unknown>(),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull()
  },
  (table) => [
    uniqueIndex("idx_conversation_fact_definitions_unique").on(table.conversationId, table.canonicalKey),
    index("idx_conversation_fact_definitions_lookup").on(
      table.conversationId, table.namespace, table.entityType, table.propertyName
    )
  ]
);

export const conversationFacts = sqliteTable(
  "conversation_facts",
  {
    id: text("id").primaryKey(),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    definitionId: text("definition_id").notNull(),
    canonicalKey: text("canonical_key").notNull(),
    valueJson: text("value_json", { mode: "json" }).$type<unknown>().notNull(),
    valueType: text("value_type").notNull(),
    status: text("status").notNull(),
    trustLevel: text("trust_level").notNull(),
    confidence: real("confidence").notNull(),
    resolutionMethod: text("resolution_method").notNull(),
    sourceType: text("source_type").notNull(),
    sourceId: text("source_id").notNull(),
    supersedesFactId: text("supersedes_fact_id"),
    invalidatedAt: integer("invalidated_at"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull()
  },
  (table) => [
    index("idx_conversation_facts_active").on(table.conversationId, table.canonicalKey, table.status),
    index("idx_conversation_facts_source").on(table.sourceType, table.sourceId)
  ]
);

export const conversationFactSources = sqliteTable(
  "conversation_fact_sources",
  {
    id: text("id").primaryKey(),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    factId: text("fact_id")
      .notNull()
      .references(() => conversationFacts.id, { onDelete: "cascade" }),
    sourceType: text("source_type").notNull(),
    sourceId: text("source_id").notNull(),
    sourceExcerpt: text("source_excerpt"),
    createdAt: integer("created_at").notNull()
  },
  (table) => [
    uniqueIndex("idx_conversation_fact_sources_unique").on(table.factId, table.sourceType, table.sourceId)
  ]
);

// ── Channel bindings ───────────────────────────────────────────────────────

/**
 * One agent speaking through one external app identity. `appSecret` lives here
 * and only here: no API returns it, and `mapChannelBinding` deliberately drops
 * it so the in-memory `ChannelBinding` type cannot carry it out of the server.
 */
export const channelBindings = sqliteTable(
  "channel_bindings",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    channel: text("channel").notNull(),
    appId: text("app_id").notNull(),
    appSecret: text("app_secret").notNull(),
    tenantBrand: text("tenant_brand"),
    botOpenId: text("bot_open_id"),
    boundByOpenId: text("bound_by_open_id"),
    chatId: text("chat_id"),
    conversationId: text("conversation_id"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull()
  },
  (table) => [
    uniqueIndex("idx_channel_bindings_agent_channel").on(table.agentId, table.channel)
  ]
);

/**
 * An external chat mapped to one AgentMeld conversation.
 *
 * Uniqueness runs both ways on purpose: a chat cannot map to two conversations,
 * and a conversation cannot be the projection target of two chats. Letting
 * either hold would make "where does this message go?" ambiguous, and the
 * inbound path has no way to resolve an ambiguity.
 */
export const channelConversations = sqliteTable(
  "channel_conversations",
  {
    id: text("id").primaryKey(),
    channel: text("channel").notNull(),
    chatId: text("chat_id").notNull(),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull()
  },
  (table) => [
    uniqueIndex("idx_channel_conversations_chat").on(table.channel, table.chatId),
    uniqueIndex("idx_channel_conversations_conversation").on(table.conversationId)
  ]
);

/**
 * Which agents have been **observed** in a chat.
 *
 * Observed, not requested: the one-click preset grants no scope that can list a
 * chat's bots (`getChatBots` answers 400), so membership can only be learned
 * from the fact that an agent's bot received an event there. A member row is
 * therefore evidence, and it accumulates rather than being asserted up front.
 */
export const channelConversationMembers = sqliteTable(
  "channel_conversation_members",
  {
    channelConversationId: text("channel_conversation_id")
      .notNull()
      .references(() => channelConversations.id, { onDelete: "cascade" }),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    firstSeenAt: integer("first_seen_at").notNull()
  },
  (table) => [
    primaryKey({ columns: [table.channelConversationId, table.agentId] })
  ]
);

/**
 * Every external message that has been taken in, one row per platform message.
 *
 * The unique index on `(channel, external_message_id)` IS the deduplication:
 * inserting is an atomic claim, so two deliveries of the same platform message
 * cannot both proceed, whether they arrive concurrently or across a restart.
 * `message_id` is null until the local message is written, which keeps the row
 * as the record of an accepted message even if writing it fails.
 */
export const channelInboundMessages = sqliteTable(
  "channel_inbound_messages",
  {
    id: text("id").primaryKey(),
    channel: text("channel").notNull(),
    chatId: text("chat_id").notNull(),
    externalMessageId: text("external_message_id").notNull(),
    conversationId: text("conversation_id").notNull(),
    messageId: text("message_id"),
    threadId: text("thread_id"),
    agentId: text("agent_id").notNull(),
    createdAt: integer("created_at").notNull()
  },
  (table) => [
    uniqueIndex("idx_channel_inbound_external").on(table.channel, table.externalMessageId),
    index("idx_channel_inbound_conversation").on(table.conversationId)
  ]
);

/**
 * The platform SDK's persistent cache.
 *
 * Deliberately generic and keyed by the SDK's own composed key (plus namespace)
 * rather than by anything AgentMeld understands: the SDK uses it for tokens as
 * well as deduplication, and narrowing it would break the parts we do not call.
 * `expired_at` is an absolute epoch-millisecond deadline, matching the SDK's
 * contract.
 */
export const channelCache = sqliteTable("channel_cache", {
  cacheKey: text("cache_key").primaryKey(),
  value: text("value").notNull(),
  expiredAt: integer("expired_at")
});
