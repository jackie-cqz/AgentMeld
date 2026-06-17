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
  archived?: boolean;
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
    .prepare("SELECT * FROM agents ORDER BY is_orchestrator DESC, created_at ASC")
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
        SET title = ?, archived = ?, pinned_message_ids = ?, fs_write_approval_mode = ?, updated_at = ?
        WHERE id = ?
      `
    )
    .run(
      input.title ?? current.title,
      typeof input.archived === "boolean" ? (input.archived ? 1 : 0) : current.archived ? 1 : 0,
      JSON.stringify(input.pinnedMessageIds ?? current.pinnedMessageIds),
      input.fsWriteApprovalMode ?? current.fsWriteApprovalMode,
      input.now,
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
          status, error, usage, started_at, finished_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      input.now,
      null,
      input.now,
      input.now
    );

  const run = getRun(input.id);
  if (!run) throw new Error("Agent run insert failed.");
  return run;
}

export function updateRunStatus(runId: string, status: AgentRunStatus, usage: UsagePayload | null, now: number) {
  getDatabase()
    .prepare("UPDATE agent_runs SET status = ?, usage = ?, finished_at = ?, updated_at = ? WHERE id = ?")
    .run(status, usage ? JSON.stringify(usage) : null, isTerminalRunStatus(status) ? now : null, now, runId);
}

function isTerminalRunStatus(status: AgentRunStatus) {
  return status === "complete" || status === "failed" || status === "aborted";
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
