import { getDatabase } from "@/db/client";
import {
  type AgentRow,
  type AgentRunRow,
  type ArtifactRow,
  type ConversationRow,
  type MessageRow,
  type WorkspaceRow,
  mapAgent,
  mapArtifact,
  mapConversation,
  mapMessage,
  mapRun,
  mapWorkspace
} from "@/db/rows";
import type {
  Agent,
  AgentRun,
  AgentRunStatus,
  Artifact,
  ArtifactContent,
  ArtifactType,
  Conversation,
  ConversationMode,
  FsWriteApprovalMode,
  Message,
  MessagePart,
  MessageRole,
  MessageStatus,
  UsagePayload
} from "@/shared/types";

interface CreateConversationInput {
  id: string;
  title: string;
  mode: ConversationMode;
  agentIds: string[];
  fsWriteApprovalMode: FsWriteApprovalMode;
  now: number;
}

interface UpdateConversationInput {
  title?: string;
  mode?: ConversationMode;
  agentIds?: string[];
  archived?: boolean;
  pinnedAt?: number | null;
  pinnedMessageIds?: string[];
  fsWriteApprovalMode?: FsWriteApprovalMode;
  now: number;
}

interface CreateMessageInput {
  id: string;
  conversationId: string;
  role: MessageRole;
  agentId?: string | null;
  runId?: string | null;
  parts: MessagePart[];
  status: MessageStatus;
  mentionedAgentIds?: string[];
  parentMessageId?: string | null;
  now: number;
}

interface CreateRunInput {
  id: string;
  conversationId: string;
  agentId: string;
  triggerMessageId?: string | null;
  parentRunId?: string | null;
  status: AgentRunStatus;
  now: number;
}

interface CreateArtifactInput {
  id: string;
  conversationId: string;
  createdByAgentId?: string | null;
  type: ArtifactType;
  title: string;
  content: ArtifactContent;
  version: number;
  parentArtifactId?: string | null;
  now: number;
}

export function listAgents(): Agent[] {
  const rows = getDatabase()
    .prepare("SELECT * FROM agents ORDER BY is_conductor DESC, created_at ASC")
    .all() as AgentRow[];
  return rows.map(mapAgent);
}

export function getAgent(agentId: string): Agent | null {
  const row = getDatabase().prepare("SELECT * FROM agents WHERE id = ?").get(agentId) as
    | AgentRow
    | undefined;
  return row ? mapAgent(row) : null;
}

export function listConversations(): Conversation[] {
  const rows = getDatabase()
    .prepare("SELECT * FROM conversations ORDER BY updated_at DESC")
    .all() as ConversationRow[];
  return rows.map(mapConversation);
}

export function getConversation(conversationId: string): Conversation | null {
  const row = getDatabase().prepare("SELECT * FROM conversations WHERE id = ?").get(conversationId) as
    | ConversationRow
    | undefined;
  return row ? mapConversation(row) : null;
}

export function createConversation(input: CreateConversationInput): Conversation {
  getDatabase()
    .prepare(
      `
        INSERT INTO conversations (
          id, title, mode, agent_ids, fs_write_approval_mode,
          pinned_message_ids, archived, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `
    )
    .run(
      input.id,
      input.title,
      input.mode,
      JSON.stringify(input.agentIds),
      input.fsWriteApprovalMode,
      JSON.stringify([]),
      0,
      input.now,
      input.now
    );

  const conversation = getConversation(input.id);
  if (!conversation) throw new Error("Conversation insert failed.");
  return conversation;
}

export function touchConversation(conversationId: string, now: number) {
  getDatabase().prepare("UPDATE conversations SET updated_at = ? WHERE id = ?").run(now, conversationId);
}

export function updateConversation(conversationId: string, input: UpdateConversationInput): Conversation | null {
  const current = getConversation(conversationId);
  if (!current) return null;

  getDatabase()
    .prepare(
      `
        UPDATE conversations
        SET title = ?, mode = ?, agent_ids = ?, archived = ?, pinned_at = ?, pinned_message_ids = ?, fs_write_approval_mode = ?, updated_at = ?
        WHERE id = ?
      `
    )
    .run(
      input.title ?? current.title,
      input.mode ?? current.mode,
      JSON.stringify(input.agentIds ?? current.agentIds),
      typeof input.archived === "boolean" ? (input.archived ? 1 : 0) : current.archived ? 1 : 0,
      input.pinnedAt !== undefined ? input.pinnedAt : current.pinnedAt ?? null,
      JSON.stringify(input.pinnedMessageIds ?? current.pinnedMessageIds),
      input.fsWriteApprovalMode ?? current.fsWriteApprovalMode,
      input.now ?? Date.now(),
      conversationId
    );

  return getConversation(conversationId);
}

export function deleteConversation(conversationId: string) {
  const workspace = getWorkspaceForConversation(conversationId);
  const result = getDatabase().prepare("DELETE FROM conversations WHERE id = ?").run(conversationId) as { changes?: number };
  return {
    deleted: (result.changes ?? 0) > 0,
    workspace
  };
}

export function getWorkspaceForConversation(conversationId: string) {
  const row = getDatabase().prepare("SELECT * FROM workspaces WHERE conversation_id = ?").get(conversationId) as
    | WorkspaceRow
    | undefined;
  return row ? mapWorkspace(row) : null;
}

export function listMessages(conversationId: string): Message[] {
  const rows = getDatabase()
    .prepare("SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC")
    .all(conversationId) as MessageRow[];
  return rows.map(mapMessage);
}

export function getMessage(messageId: string): Message | null {
  const row = getDatabase().prepare("SELECT * FROM messages WHERE id = ?").get(messageId) as
    | MessageRow
    | undefined;
  return row ? mapMessage(row) : null;
}

export function createMessage(input: CreateMessageInput): Message {
  getDatabase()
    .prepare(
      `
        INSERT INTO messages (
          id, conversation_id, role, agent_id, run_id, parts, status,
          mentioned_agent_ids, parent_message_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `
    )
    .run(
      input.id,
      input.conversationId,
      input.role,
      input.agentId ?? null,
      input.runId ?? null,
      JSON.stringify(input.parts),
      input.status,
      JSON.stringify(input.mentionedAgentIds ?? []),
      input.parentMessageId ?? null,
      input.now,
      input.now
    );

  const message = getMessage(input.id);
  if (!message) throw new Error("Message insert failed.");
  return message;
}

export function updateMessageParts(messageId: string, parts: MessagePart[], now: number) {
  getDatabase()
    .prepare("UPDATE messages SET parts = ?, updated_at = ? WHERE id = ?")
    .run(JSON.stringify(parts), now, messageId);
}

export function updateMessageStatus(messageId: string, status: MessageStatus, now: number) {
  getDatabase()
    .prepare("UPDATE messages SET status = ?, updated_at = ? WHERE id = ?")
    .run(status, now, messageId);
}

export function listRuns(conversationId: string): AgentRun[] {
  const rows = getDatabase()
    .prepare("SELECT * FROM agent_runs WHERE conversation_id = ? ORDER BY created_at ASC")
    .all(conversationId) as AgentRunRow[];
  return rows.map(mapRun);
}

export function getRun(runId: string): AgentRun | null {
  const row = getDatabase().prepare("SELECT * FROM agent_runs WHERE id = ?").get(runId) as
    | AgentRunRow
    | undefined;
  return row ? mapRun(row) : null;
}

export function createRun(input: CreateRunInput): AgentRun {
  getDatabase()
    .prepare(
      `
        INSERT INTO agent_runs (
          id, conversation_id, agent_id, trigger_message_id, parent_run_id,
          status, stage, error, usage, interrupted, started_at, finished_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `
    )
    .run(
      input.id,
      input.conversationId,
      input.agentId,
      input.triggerMessageId ?? null,
      input.parentRunId ?? null,
      input.status,
      null,
      null,
      null,
      0,
      input.now,
      null,
      input.now,
      input.now
    );

  const run = getRun(input.id);
  if (!run) throw new Error("Agent run insert failed.");
  return run;
}

export function updateRunStatus(runId: string, status: AgentRunStatus, usage: UsagePayload | null, now: number, errorCategory?: string | null, retryable?: boolean) {
  getDatabase()
    .prepare("UPDATE agent_runs SET status = ?, usage = ?, finished_at = ?, updated_at = ?, error_category = ?, retryable = ? WHERE id = ?")
    .run(status, usage ? JSON.stringify(usage) : null, isTerminalRunStatus(status) ? now : null, now, errorCategory ?? null, retryable ? 1 : 0, runId);
}

export function updateRunStage(runId: string, stage: string, now: number) {
  getDatabase()
    .prepare("UPDATE agent_runs SET stage = ?, updated_at = ? WHERE id = ?")
    .run(stage, now, runId);
}

export function markRunInterrupted(runId: string, now: number) {
  getDatabase()
    .prepare("UPDATE agent_runs SET status = 'failed', interrupted = 1, error = 'Run interrupted: server restarted while running.', finished_at = ?, updated_at = ? WHERE id = ?")
    .run(now, now, runId);
}

export function listOrphanedRunningRuns(): AgentRun[] {
  const rows = getDatabase()
    .prepare("SELECT * FROM agent_runs WHERE status = 'running'")
    .all() as AgentRunRow[];
  return rows.map(mapRun);
}

export function listChildRunIds(parentRunId: string): string[] {
  const rows = getDatabase()
    .prepare("SELECT id FROM agent_runs WHERE parent_run_id = ? AND status = 'running'")
    .all(parentRunId) as Array<{ id: string }>;
  return rows.map((r) => r.id);
}

// ── Conductor task persistence ──

export function persistConductorTask(record: {
  id: string;
  conductorRunId: string;
  conversationId: string;
  taskId: string;
  agentId: string;
  title?: string | null;
  status: string;
  summary?: string | null;
  childRunId?: string | null;
  attempt: number;
  errorCategory?: string | null;
  now: number;
}) {
  getDatabase()
    .prepare(`
      INSERT OR REPLACE INTO conductor_task_results (
        id, conductor_run_id, conversation_id, task_id, agent_id,
        title, status, summary, child_run_id, attempt, error_category,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    .run(
      record.id, record.conductorRunId, record.conversationId,
      record.taskId, record.agentId, record.title ?? null,
      record.status, record.summary ?? null, record.childRunId ?? null,
      record.attempt, record.errorCategory ?? null,
      record.now, record.now
    );
}

function isTerminalRunStatus(status: AgentRunStatus) {
  return status === "complete" || status === "failed" || status === "aborted";
}

// ── P2: Unified approval persistence ──

export function persistApproval(record: {
  id: string;
  conversationId: string;
  agentId: string;
  runId: string;
  approvalType: string;
  payloadJson: string;
  now: number;
}) {
  getDatabase()
    .prepare(`
      INSERT INTO pending_approvals (id, conversation_id, agent_id, run_id, approval_type, status, payload_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?)
    `)
    .run(record.id, record.conversationId, record.agentId, record.runId,
      record.approvalType, record.payloadJson, record.now, record.now);
}

/**
 * Conditionally resolve an approval. Returns true only if the approval
 * was still 'pending' — prevents duplicate resolution.
 */
export function resolveApproval(id: string, approved: boolean, now: number): boolean {
  const result = getDatabase()
    .prepare(`
      UPDATE pending_approvals
      SET status = ?, resolved_by = ?, resolved_at = ?, updated_at = ?
      WHERE id = ? AND status = 'pending'
    `)
    .run(approved ? "approved" : "rejected", approved ? "approved" : "rejected", now, now, id) as {
      changes?: number;
    };
  return (result.changes ?? 0) > 0;
}

export function cancelApproval(id: string, now: number): boolean {
  const result = getDatabase()
    .prepare(`
      UPDATE pending_approvals
      SET status = 'cancelled', updated_at = ?
      WHERE id = ? AND status = 'pending'
    `)
    .run(now, id) as { changes?: number };
  return (result.changes ?? 0) > 0;
}

/** Mark all pending approvals for a run as cancelled */
export function cancelApprovalsForRun(runId: string, now: number) {
  getDatabase()
    .prepare(`
      UPDATE pending_approvals
      SET status = 'cancelled', updated_at = ?
      WHERE run_id = ? AND status = 'pending'
    `)
    .run(now, runId);
}

/** Startup recovery: mark all pending approvals as interrupted */
export function interruptAllPendingApprovals(now: number) {
  getDatabase()
    .prepare(`
      UPDATE pending_approvals
      SET status = 'interrupted', updated_at = ?
      WHERE status = 'pending'
    `)
    .run(now);
}

export function listArtifacts(conversationId: string): Artifact[] {
  const rows = getDatabase()
    .prepare("SELECT * FROM artifacts WHERE conversation_id = ? ORDER BY updated_at DESC")
    .all(conversationId) as ArtifactRow[];
  return rows.map(mapArtifact);
}

export function getArtifact(artifactId: string): Artifact | null {
  const row = getDatabase().prepare("SELECT * FROM artifacts WHERE id = ?").get(artifactId) as
    | ArtifactRow
    | undefined;
  return row ? mapArtifact(row) : null;
}

export function createArtifact(input: CreateArtifactInput): Artifact {
  getDatabase()
    .prepare(
      `
        INSERT INTO artifacts (
          id, conversation_id, created_by_agent_id, type, title, content,
          version, parent_artifact_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `
    )
    .run(
      input.id,
      input.conversationId,
      input.createdByAgentId ?? null,
      input.type,
      input.title,
      JSON.stringify(input.content),
      input.version,
      input.parentArtifactId ?? null,
      input.now,
      input.now
    );

  const artifact = getArtifact(input.id);
  if (!artifact) throw new Error("Artifact insert failed.");
  return artifact;
}

// ── P2: Conductor state persistence ──

export function persistConductorPlan(record: {
  id: string;
  conductorRunId: string;
  conversationId: string;
  planJson: string;
  revision?: number;
  status?: string;
  userFeedback?: string | null;
  stageAtCreation?: string | null;
  resumedFromRunId?: string | null;
  now: number;
}) {
  getDatabase().prepare(`
    INSERT INTO conductor_plans (id, conductor_run_id, conversation_id, revision, plan_json, status, user_feedback, stage_at_creation, resumed_from_run_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    record.id, record.conductorRunId, record.conversationId,
    record.revision ?? 0, record.planJson, record.status ?? "active",
    record.userFeedback ?? null, record.stageAtCreation ?? null,
    record.resumedFromRunId ?? null, record.now
  );
}

export function persistOutputBinding(record: {
  conductorRunId: string;
  planId: string;
  producerTaskId: string;
  outputKey: string;
  artifactId: string;
  now: number;
}) {
  getDatabase().prepare(`
    INSERT OR REPLACE INTO conductor_output_bindings (conductor_run_id, plan_id, producer_task_id, output_key, artifact_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(record.conductorRunId, record.planId, record.producerTaskId, record.outputKey, record.artifactId, record.now);
}

export function persistConductorConflict(record: {
  id: string;
  conductorRunId: string;
  planId: string;
  path: string;
  wave: number;
  contributorsJson: string;
  now: number;
}) {
  getDatabase().prepare(`
    INSERT INTO conductor_conflicts (id, conductor_run_id, plan_id, path, wave, contributors_json, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, 'detected', ?)
  `).run(record.id, record.conductorRunId, record.planId, record.path, record.wave, record.contributorsJson, record.now);
}

export function listConductorPlans(conductorRunId: string): Array<Record<string, unknown>> {
  return getDatabase().prepare(
    "SELECT * FROM conductor_plans WHERE conductor_run_id = ? ORDER BY revision ASC"
  ).all(conductorRunId) as Array<Record<string, unknown>>;
}

export function listOutputBindings(planId: string): Array<Record<string, unknown>> {
  return getDatabase().prepare(
    "SELECT * FROM conductor_output_bindings WHERE plan_id = ?"
  ).all(planId) as Array<Record<string, unknown>>;
}

export function listConductorConflicts(conductorRunId: string): Array<Record<string, unknown>> {
  return getDatabase().prepare(
    "SELECT * FROM conductor_conflicts WHERE conductor_run_id = ?"
  ).all(conductorRunId) as Array<Record<string, unknown>>;
}
