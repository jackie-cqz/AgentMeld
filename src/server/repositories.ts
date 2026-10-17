import { getDatabase } from "@/db/client";
import {
  type AgentRow,
  type AgentRunRow,
  type ArtifactRow,
  type ChannelBindingRow,
  type ConversationRow,
  type MessageRow,
  type WorkspaceRow,
  mapAgent,
  mapArtifact,
  mapChannelBinding,
  mapConversation,
  mapMessage,
  mapRun,
  mapWorkspace,
  mapChannelConversation,
  type ChannelConversationRow} from "@/db/rows";
import type {
  Agent,
  AgentRun,
  AgentRunStatus,
  Artifact,
  ArtifactContent,
  ArtifactType,
  ChannelBinding,
  ChannelConversation,
  Conversation,
  ConversationMode,
  ContextMode,
  FsWriteApprovalMode,
  Message,
  MessagePart,
  MessageOrigin,
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
  /** Defaults to `raw`; the service and channel binding state it explicitly. */
  contextMode?: ContextMode;
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
  /**
   * Who authored the message. Defaults by role: user-role messages are human,
   * everything else is internal. Pass it explicitly for channel ingress.
   */
  origin?: MessageOrigin;
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
          id, title, mode, agent_ids, fs_write_approval_mode, context_mode,
          pinned_message_ids, archived, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `
    )
    .run(
      input.id,
      input.title,
      input.mode,
      JSON.stringify(input.agentIds),
      input.fsWriteApprovalMode,
      input.contextMode ?? "raw",
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

/**
 * Who authored a message when the caller does not say. Mirrors the role:
 * user-role messages are typed by a person, agent-role messages carry an
 * agent's bot identity, and system-role messages are runtime bookkeeping.
 * Keep this in step with `message-events.ts`, which builds the optimistic
 * streaming message for an agent as `bot`.
 */
function defaultOriginForRole(role: MessageRole): MessageOrigin {
  if (role === "user") return "human";
  if (role === "agent") return "bot";
  return "internal";
}

export function createMessage(input: CreateMessageInput): Message {
  getDatabase()
    .prepare(
      `
        INSERT INTO messages (
          id, conversation_id, role, origin, agent_id, run_id, parts, status,
          mentioned_agent_ids, parent_message_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `
    )
    .run(
      input.id,
      input.conversationId,
      input.role,
      input.origin ?? defaultOriginForRole(input.role),
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

/**
 * Settle the messages a stopped run was streaming into.
 *
 * A restart kills a run mid-answer, and the run's own recovery marks the RUN
 * interrupted — but the message row it was writing stays `streaming` forever,
 * because only the run that owned it ever finishes it. The room then shows a
 * message that spins with nothing in it, which looks exactly like a frozen
 * server. The note is appended so the row explains itself.
 */
export function failStreamingMessagesForRun(runId: string, note: string, now: number): number {
  const rows = getDatabase()
    .prepare("SELECT id, parts FROM messages WHERE run_id = ? AND status = 'streaming'")
    .all(runId) as Array<{ id: string; parts: string | null }>;
  for (const row of rows) {
    let parts: unknown[] = [];
    try {
      const parsed = JSON.parse(row.parts ?? "[]");
      parts = Array.isArray(parsed) ? parsed : [];
    } catch {
      parts = [];
    }
    getDatabase()
      .prepare("UPDATE messages SET status = 'error', parts = ?, updated_at = ? WHERE id = ?")
      .run(JSON.stringify([...parts, { type: "text", content: note }]), now, row.id);
  }
  return rows.length;
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
  /** Evidence-verification outcome. The column is NOT NULL with a default, so a
   *  task that never ran (skipped/aborted) is stored as "not_started". */
  verificationStatus?: string | null;
  now: number;
}) {
  getDatabase()
    .prepare(`
      INSERT OR REPLACE INTO conductor_task_results (
        id, conductor_run_id, conversation_id, task_id, agent_id,
        title, status, summary, child_run_id, attempt, error_category,
        verification_status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    .run(
      record.id, record.conductorRunId, record.conversationId,
      record.taskId, record.agentId, record.title ?? null,
      record.status, record.summary ?? null, record.childRunId ?? null,
      record.attempt, record.errorCategory ?? null,
      record.verificationStatus ?? "not_started",
      record.now, record.now
    );
}

export function isTerminalRunStatus(status: AgentRunStatus) {
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

export interface ApprovalRecord {
  id: string;
  conversationId: string;
  agentId: string;
  runId: string;
  approvalType: string;
  status: string;
  /**
   * WHO resolved it, as an authenticated principal (issue #24):
   * `owner:session:<id>`, `device:companion`, `feishu:<appId>:<openId>`, or
   * `system` for test teardown.
   *
   * Rows written BEFORE that change may hold a caller-declared string in this
   * column instead — the column was write-only and unverified then, and the
   * migration does not rewrite history. So this is a trustworthy identity for
   * anything written since, and a historical label for anything older; nothing
   * in the codebase authorizes on it either way.
   */
  resolvedBy: string | null;
  /** What the caller SAID it was. Display only; grants nothing. */
  resolvedByLabel: string | null;
  resolvedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

/** Upper bound for a caller-supplied `resolvedBy` label. */
export const MAX_RESOLVED_BY_LENGTH = 128;

/**
 * Attribution label for approvals that reject themselves during test teardown
 * (`clearPending*ForTests`). It is NOT used by run cancellation: that goes
 * through `cancelApproval` / `cancelApprovalsForRun` /
 * `interruptAllPendingApprovals`, which leave `resolved_by` NULL because
 * nobody decided anything — the `status` carries that story instead.
 */
export const SYSTEM_RESOLVED_BY = "system";

function mapApprovalRow(row: Record<string, unknown>): ApprovalRecord {
  return {
    id: row.id as string,
    conversationId: row.conversation_id as string,
    agentId: row.agent_id as string,
    runId: row.run_id as string,
    approvalType: row.approval_type as string,
    status: row.status as string,
    resolvedBy: (row.resolved_by as string | null) ?? null,
    resolvedByLabel: (row.resolved_by_label as string | null) ?? null,
    resolvedAt: (row.resolved_at as number | null) ?? null,
    createdAt: row.created_at as number,
    updatedAt: row.updated_at as number
  };
}

/**
 * Read an approval back, including who resolved it.
 *
 * This read path did not exist before: `resolved_by` was write-only, so the
 * fact that it held the *status* instead of an operator went unnoticed.
 *
 * `resolvedAt` is when the row stopped being pending, for any reason:
 * approved, rejected, cancelled, or interrupted. `resolvedBy` is only set when
 * somebody decided — a cancelled or interrupted row has a timestamp and a null
 * operator, and its `status` says which happened.
 */
export function getApprovalRecord(id: string): ApprovalRecord | undefined {
  const row = getDatabase()
    .prepare("SELECT * FROM pending_approvals WHERE id = ?")
    .get(id) as Record<string, unknown> | undefined;
  return row ? mapApprovalRow(row) : undefined;
}

function normalizeResolvedBy(resolvedBy: string | null | undefined): string | null {
  const trimmed = resolvedBy?.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, MAX_RESOLVED_BY_LENGTH);
}

/** Same cap, different meaning: this one is never identity. */
function normalizeResolvedByLabel(label: string | null | undefined): string | null {
  const trimmed = label?.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, MAX_RESOLVED_BY_LENGTH);
}

/**
 * Conditionally resolve an approval. Returns true only if the approval
 * was still 'pending' — prevents duplicate resolution.
 *
 * `resolvedBy` must come from the authenticated principal (see
 * `describePrincipal` in server/auth.ts) — the resolve routes derive it from
 * the request's session/device token, and the Feishu path from the callback's
 * app-scoped operator id. Callers that only have a display string pass it as
 * `resolvedByLabel`, which sits in its own column and grants nothing.
 *
 * Omit both — or pass null — when the operator is unknown, so the columns stay
 * NULL rather than guessing.
 */
export function resolveApproval(
  id: string,
  approved: boolean,
  now: number,
  resolvedBy: string | null = null,
  resolvedByLabel: string | null = null
): boolean {
  const result = getDatabase()
    .prepare(`
      UPDATE pending_approvals
      SET status = ?, resolved_by = ?, resolved_by_label = ?, resolved_at = ?, updated_at = ?
      WHERE id = ? AND status = 'pending'
    `)
    .run(
      approved ? "approved" : "rejected",
      normalizeResolvedBy(resolvedBy),
      normalizeResolvedByLabel(resolvedByLabel),
      now,
      now,
      id
    ) as {
      changes?: number;
    };
  return (result.changes ?? 0) > 0;
}

export function cancelApproval(id: string, now: number): boolean {
  const result = getDatabase()
    .prepare(`
      UPDATE pending_approvals
      SET status = 'cancelled', resolved_at = ?, updated_at = ?
      WHERE id = ? AND status = 'pending'
    `)
    .run(now, now, id) as { changes?: number };
  return (result.changes ?? 0) > 0;
}

/** Mark all pending approvals for a run as cancelled */
export function cancelApprovalsForRun(runId: string, now: number) {
  getDatabase()
    .prepare(`
      UPDATE pending_approvals
      SET status = 'cancelled', resolved_at = ?, updated_at = ?
      WHERE run_id = ? AND status = 'pending'
    `)
    .run(now, now, runId);
}

/** Startup recovery: mark all pending approvals as interrupted */
export function interruptAllPendingApprovals(now: number) {
  getDatabase()
    .prepare(`
      UPDATE pending_approvals
      SET status = 'interrupted', resolved_at = ?, updated_at = ?
      WHERE status = 'pending'
    `)
    .run(now, now);
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
  actualProducerTaskId?: string;
  now: number;
}) {
  getDatabase().prepare(`
    INSERT OR REPLACE INTO conductor_output_bindings (
      conductor_run_id, plan_id, producer_task_id, output_key, artifact_id,
      created_at, superseded_at, replaced_by_task_id, actual_producer_task_id
    )
    VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?)
  `).run(
    record.conductorRunId,
    record.planId,
    record.producerTaskId,
    record.outputKey,
    record.artifactId,
    record.now,
    record.actualProducerTaskId ?? null,
  );
}

export function supersedeOutputBinding(record: {
  conductorRunId: string;
  producerTaskId: string;
  outputKey: string;
  replacedByTaskId: string;
  now: number;
}) {
  getDatabase().prepare(`
    UPDATE conductor_output_bindings
    SET superseded_at = ?, replaced_by_task_id = ?
    WHERE conductor_run_id = ?
      AND producer_task_id = ?
      AND output_key = ?
      AND superseded_at IS NULL
  `).run(
    record.now,
    record.replacedByTaskId,
    record.conductorRunId,
    record.producerTaskId,
    record.outputKey,
  );
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
    "SELECT * FROM conductor_output_bindings WHERE plan_id = ? AND superseded_at IS NULL"
  ).all(planId) as Array<Record<string, unknown>>;
}

export function listConductorConflicts(conductorRunId: string): Array<Record<string, unknown>> {
  return getDatabase().prepare(
    "SELECT * FROM conductor_conflicts WHERE conductor_run_id = ?"
  ).all(conductorRunId) as Array<Record<string, unknown>>;
}

// ── Channel bindings ───────────────────────────────────────────────────────

/**
 * Create or replace the binding for one agent on one channel, so a re-scan
 * updates the identity instead of accumulating rows.
 */
export function upsertChannelBinding(input: {
  id: string;
  agentId: string;
  channel: ChannelBinding["channel"];
  appId: string;
  appSecret: string;
  tenantBrand?: string | null;
  botOpenId?: string | null;
  boundByOpenId?: string | null;
  now: number;
}): ChannelBinding {
  getDatabase()
    .prepare(`
      INSERT INTO channel_bindings (
        id, agent_id, channel, app_id, app_secret, tenant_brand,
        bot_open_id, bound_by_open_id, chat_id, conversation_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)
      ON CONFLICT(agent_id, channel) DO UPDATE SET
        app_id = excluded.app_id,
        app_secret = excluded.app_secret,
        tenant_brand = excluded.tenant_brand,
        bot_open_id = excluded.bot_open_id,
        bound_by_open_id = excluded.bound_by_open_id,
        updated_at = excluded.updated_at
    `)
    .run(
      input.id,
      input.agentId,
      input.channel,
      input.appId,
      input.appSecret,
      input.tenantBrand ?? null,
      input.botOpenId ?? null,
      input.boundByOpenId ?? null,
      input.now,
      input.now
    );

  const binding = getChannelBindingForAgent(input.agentId, input.channel);
  if (!binding) throw new Error("Channel binding insert failed.");
  return binding;
}

/** Bindings with the app secret already removed by `mapChannelBinding`. */
export function listChannelBindings(): ChannelBinding[] {
  const rows = getDatabase()
    .prepare("SELECT * FROM channel_bindings ORDER BY created_at ASC")
    .all() as ChannelBindingRow[];
  return rows.map(mapChannelBinding);
}

export function getChannelBindingForAgent(
  agentId: string,
  channel: ChannelBinding["channel"]
): ChannelBinding | undefined {
  const row = getDatabase()
    .prepare("SELECT * FROM channel_bindings WHERE agent_id = ? AND channel = ?")
    .get(agentId, channel) as ChannelBindingRow | undefined;
  return row ? mapChannelBinding(row) : undefined;
}

export function deleteChannelBinding(id: string): boolean {
  const result = getDatabase()
    .prepare("DELETE FROM channel_bindings WHERE id = ?")
    .run(id) as { changes?: number };
  return (result.changes ?? 0) > 0;
}

/**
 * The only way to read an app secret back. Kept as a narrow, explicitly named
 * accessor so the secret cannot ride along on an ordinary binding read — and so
 * a grep for `app_secret` finds exactly one intended caller.
 */
export function getChannelBindingSecret(id: string): string | undefined {
  const row = getDatabase()
    .prepare("SELECT app_secret FROM channel_bindings WHERE id = ?")
    .get(id) as { app_secret: string } | undefined;
  return row?.app_secret;
}

/**
 * Remember which bot an app speaks as. Written once a connection resolves its
 * identity, so a mentioned open id can later be mapped back to the agent that
 * owns it without a live connection being present.
 */
/**
 * Record who owns this binding, without touching anything else.
 *
 * A full upsert would take the caller's fields as the new truth, and the manual
 * binding flow does not have the app secret in hand at claim time — writing it
 * back empty would silently break the connection it just established.
 */
export function setChannelBindingOwner(agentId: string, channel: string, openId: string): boolean {
  const result = getDatabase()
    .prepare(
      "UPDATE channel_bindings SET bound_by_open_id = ?, updated_at = ? WHERE agent_id = ? AND channel = ?"
    )
    .run(openId, Date.now(), agentId, channel) as { changes?: number };
  return (result.changes ?? 0) > 0;
}

export function setChannelBindingBotOpenId(id: string, botOpenId: string): void {
  getDatabase()
    .prepare("UPDATE channel_bindings SET bot_open_id = ?, updated_at = ? WHERE id = ?")
    .run(botOpenId, Date.now(), id);
}

/**
 * The agent whose bot is this open id, if any.
 *
 * Deliberately returns null rather than guessing: a mention of something that
 * is not one of our bound agents (a person, or a bot we do not manage) must not
 * be routed to an arbitrary agent.
 */
export function findAgentIdByBotOpenId(channel: string, botOpenId: string): string | null {
  const row = getDatabase()
    .prepare("SELECT agent_id FROM channel_bindings WHERE channel = ? AND bot_open_id = ?")
    .get(channel, botOpenId) as { agent_id: string } | undefined;
  return row?.agent_id ?? null;
}

// ---------------------------------------------------------------------------
// Channel conversations (external chat <-> AgentMeld conversation)
// ---------------------------------------------------------------------------

export function getChannelConversationByChat(
  channel: string,
  chatId: string
): ChannelConversation | null {
  const row = getDatabase()
    .prepare("SELECT * FROM channel_conversations WHERE channel = ? AND chat_id = ?")
    .get(channel, chatId) as ChannelConversationRow | undefined;
  return row ? mapChannelConversation(row) : null;
}

/**
 * The chat a conversation projects to, if it is a channel conversation at all.
 *
 * The unique index on `conversation_id` is what makes this a single row rather
 * than a choice: a conversation has at most one chat it speaks to.
 */
export function getChannelConversationByConversationId(
  conversationId: string
): ChannelConversation | null {
  const row = getDatabase()
    .prepare("SELECT * FROM channel_conversations WHERE conversation_id = ?")
    .get(conversationId) as ChannelConversationRow | undefined;
  return row ? mapChannelConversation(row) : null;
}

export function createChannelConversation(input: {
  id: string;
  channel: string;
  chatId: string;
  conversationId: string;
  now: number;
}): ChannelConversation {
  getDatabase()
    .prepare(`
      INSERT INTO channel_conversations (id, channel, chat_id, conversation_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `)
    .run(input.id, input.channel, input.chatId, input.conversationId, input.now, input.now);
  return {
    id: input.id,
    channel: input.channel as ChannelConversation["channel"],
    chatId: input.chatId,
    conversationId: input.conversationId,
    createdAt: input.now,
    updatedAt: input.now
  };
}

export function listChannelConversationMembers(channelConversationId: string): string[] {
  const rows = getDatabase()
    .prepare(
      "SELECT agent_id FROM channel_conversation_members WHERE channel_conversation_id = ? ORDER BY first_seen_at ASC"
    )
    .all(channelConversationId) as Array<{ agent_id: string }>;
  return rows.map((row) => row.agent_id);
}

/**
 * Forget that an agent's bot is in a chat.
 *
 * Membership is evidence, and evidence can be falsified: a bot that leaves the
 * group is no longer in the room, and a roster that only grows would keep
 * offering it as a member (and, since artifact delivery picks a carrier from the
 * observed members, keep choosing a bot that cannot send).
 */
export function removeChannelConversationMember(
  channelConversationId: string,
  agentId: string
): boolean {
  const result = getDatabase()
    .prepare(
      "DELETE FROM channel_conversation_members WHERE channel_conversation_id = ? AND agent_id = ?"
    )
    .run(channelConversationId, agentId) as { changes?: number };
  return (result.changes ?? 0) > 0;
}

/**
 * Record that an agent's bot has been seen in a chat. Idempotent — membership is
 * evidence, and seeing the same bot twice is not new evidence.
 */
export function addChannelConversationMember(input: {
  channelConversationId: string;
  agentId: string;
  now: number;
}): void {
  getDatabase()
    .prepare(`
      INSERT OR IGNORE INTO channel_conversation_members (channel_conversation_id, agent_id, first_seen_at)
      VALUES (?, ?, ?)
    `)
    .run(input.channelConversationId, input.agentId, input.now);
}

/**
 * Claim an external message for processing. Returns false when it was already
 * claimed.
 *
 * The insert is the deduplication: the unique index on
 * `(channel, external_message_id)` makes "have I seen this?" and "mark it seen"
 * one atomic step, so two concurrent deliveries cannot both win and a redelivery
 * after a restart cannot win either. Reading first and writing after would race.
 */
export function claimChannelInboundMessage(input: {
  id: string;
  channel: string;
  chatId: string;
  externalMessageId: string;
  conversationId: string;
  agentId: string;
  threadId?: string | null;
  now: number;
}): boolean {
  const result = getDatabase()
    .prepare(`
      INSERT INTO channel_inbound_messages (
        id, channel, chat_id, external_message_id, conversation_id, message_id, thread_id, agent_id, created_at
      ) VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?)
      ON CONFLICT(channel, external_message_id) DO NOTHING
    `)
    .run(
      input.id,
      input.channel,
      input.chatId,
      input.externalMessageId,
      input.conversationId,
      input.threadId ?? null,
      input.agentId,
      input.now
    ) as { changes?: number };
  return (result.changes ?? 0) > 0;
}

/** Point a claimed inbound row at the local message it became. */
export function setChannelInboundMessageId(id: string, messageId: string): void {
  getDatabase()
    .prepare("UPDATE channel_inbound_messages SET message_id = ? WHERE id = ?")
    .run(messageId, id);
}

/**
 * The Feishu context of the message that triggered a run, so the answer can go
 * back into the topic the question was asked in.
 *
 * Looked up through the LOCAL message id the inbound record became, which is
 * what a run points at.
 */
export function getChannelInboundThread(
  localMessageId: string
): { externalMessageId: string; threadId: string | null } | null {
  const row = getDatabase()
    .prepare(
      "SELECT external_message_id, thread_id FROM channel_inbound_messages WHERE message_id = ?"
    )
    .get(localMessageId) as { external_message_id: string; thread_id: string | null } | undefined;
  return row
    ? { externalMessageId: row.external_message_id, threadId: row.thread_id ?? null }
    : null;
}

export function getChannelInboundMessage(
  channel: string,
  externalMessageId: string
): { id: string; messageId: string | null; conversationId: string } | null {
  const row = getDatabase()
    .prepare(
      "SELECT id, message_id, conversation_id FROM channel_inbound_messages WHERE channel = ? AND external_message_id = ?"
    )
    .get(channel, externalMessageId) as
    | { id: string; message_id: string | null; conversation_id: string }
    | undefined;
  return row ? { id: row.id, messageId: row.message_id, conversationId: row.conversation_id } : null;
}
