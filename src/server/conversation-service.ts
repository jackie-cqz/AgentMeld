import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { ensureDatabase } from "@/db/bootstrap";
import { getDataDir, getDatabase } from "@/db/client";
import { startAgentRun } from "@/server/agent-runner";
import { deployArtifact } from "@/server/deployment-service";
import { eventBus } from "@/server/event-bus";
import { getAllPendingBashCommands } from "@/server/pending-bash";
import { getAllPendingPlans } from "@/server/dispatch-plan-manager";
import { getAllPendingQuestions } from "@/server/pending-questions";
import { getAllPendingWrites } from "@/server/pending-writes";
import {
  createConversation as insertConversation,
  createMessage,
  deleteConversation as removeConversation,
  getConversation,
  getMessage,
  getRun,
  listAgents,
  listArtifacts,
  listConversations,
  listMessages,
  listRuns,
  touchConversation,
  updateConversation
} from "@/server/repositories";
import { PIN_LIMIT_PER_CONVERSATION } from "@/shared/constants";
import { newConversationId, newMessageId, newWorkspaceId } from "@/shared/ids";
import type { Agent, Conversation, FsWriteApprovalMode, Message, MessageOrigin } from "@/shared/types";
import { resolveMessageRecipients } from "@/shared/collaboration-routing";
import { listConsultations } from "@/server/collaboration/consultations";
import { listHandoffs } from "@/server/collaboration/handoffs";
import { publicCollaborationTurns } from "@/server/collaboration/turn-admission";
import { claimMessageSubmission, finishMessageSubmission } from "@/server/collaboration/message-submissions";
import type { CollaborationAction } from "@/shared/collaboration-types";

interface BootstrapPayload {
  agents: Agent[];
  conversations: Conversation[];
  messagesByConversation: Record<string, Message[]>;
  runsByConversation: Record<string, ReturnType<typeof listRuns>>;
  artifactsByConversation: Record<string, ReturnType<typeof listArtifacts>>;
  pendingWrites: ReturnType<typeof getAllPendingWrites>;
  pendingBashCommands: ReturnType<typeof getAllPendingBashCommands>;
  pendingDispatchPlans: ReturnType<typeof getAllPendingPlans>;
  pendingQuestions: ReturnType<typeof getAllPendingQuestions>;
  consultationsByConversation: Record<string, ReturnType<typeof listConsultations>>;
  collaborationTurnsByConversation: Record<string, ReturnType<typeof publicCollaborationTurns>>;
  handoffsByConversation: Record<string, ReturnType<typeof listHandoffs>>;
}

interface CreateConversationInput {
  title?: string;
  mode?: "single" | "group";
  agentIds?: string[];
  fsWriteApprovalMode?: FsWriteApprovalMode;
}

interface UpdateConversationInput {
  title?: string;
  archived?: boolean;
  pinnedMessageIds?: string[];
  fsWriteApprovalMode?: FsWriteApprovalMode;
  mode?: "single" | "group";
  agentIds?: string[];
  pinnedAt?: number | null;
}

interface SendMessageInput {
  conversationId: string;
  content: string;
  mentionedAgentIds?: string[];
  attachmentIds?: string[];
  parentMessageId?: string | null;
  clientRequestId?: string;
  action?: CollaborationAction;
  targetRunId?: string;
  /**
   * Who authored the message. Required on purpose: this is the boundary channel
   * ingress will call, and a default of "human" would mean a future caller that
   * forgets the field silently gets permission to start runs. Making it
   * mandatory turns that omission into a compile error instead.
   */
  origin: MessageOrigin;
}

export function getBootstrapPayload(): BootstrapPayload {
  ensureDatabase();
  const conversations = listConversations();
  return {
    agents: listAgents(),
    conversations,
    consultationsByConversation: Object.fromEntries(conversations.map(conversation => [conversation.id, listConsultations(conversation.id)])),
    collaborationTurnsByConversation: Object.fromEntries(conversations.map(conversation => [conversation.id, publicCollaborationTurns(conversation.id)])),
    handoffsByConversation: Object.fromEntries(conversations.map(conversation => [conversation.id, listHandoffs(conversation.id)])),
    messagesByConversation: Object.fromEntries(
      conversations.map((conversation) => [conversation.id, listMessages(conversation.id)])
    ),
    runsByConversation: Object.fromEntries(conversations.map((conversation) => [conversation.id, listRuns(conversation.id)])),
    artifactsByConversation: Object.fromEntries(
      conversations.map((conversation) => [conversation.id, listArtifacts(conversation.id)])
    ),
    pendingWrites: getAllPendingWrites(),
    pendingBashCommands: getAllPendingBashCommands(),
    pendingDispatchPlans: getAllPendingPlans(),
    pendingQuestions: getAllPendingQuestions()
  };
}

export function createConversation(input: CreateConversationInput) {
  ensureDatabase();
  const agents = listAgents();
  const agentIds =
    input.agentIds && input.agentIds.length > 0
      ? input.agentIds
      : agents.filter((agent) => agent.isConductor || agent.name.includes("前端")).map((agent) => agent.id);
  const mode = input.mode ?? (agentIds.length > 1 ? "group" : "single");

  validateConversationAgents(mode, agentIds, agents);

  const now = Date.now();
  const conversation = insertConversation({
    id: newConversationId(),
    title: input.title?.trim() || "新的 Agent 协作",
    mode,
    agentIds,
    fsWriteApprovalMode: input.fsWriteApprovalMode ?? "auto",
    now
  });

  createWorkspace(conversation.id, now);
  return conversation;
}

export function getConversationPayload(conversationId: string) {
  ensureDatabase();
  const conversation = getConversation(conversationId);
  if (!conversation) return null;

  return {
    conversation,
    consultations: listConsultations(conversationId),
    collaborationTurns: publicCollaborationTurns(conversationId),
    handoffs: listHandoffs(conversationId),
    messages: listMessages(conversationId),
    runs: listRuns(conversationId),
    artifacts: listArtifacts(conversationId)
  };
}

export function patchConversation(conversationId: string, input: UpdateConversationInput) {
  ensureDatabase();
  if (input.pinnedMessageIds && input.pinnedMessageIds.length > PIN_LIMIT_PER_CONVERSATION) {
    throw new Error("PIN_LIMIT_EXCEEDED");
  }

  const current = getConversation(conversationId);
  if (!current) return null;
  const mode = input.mode ?? current.mode;
  const agentIds = input.agentIds ?? current.agentIds;
  validateConversationAgents(mode, agentIds, listAgents());

  return updateConversation(conversationId, {
    ...input,
    mode,
    agentIds,
    title: input.title?.trim() || undefined,
    now: Date.now()
  });
}

export function deleteConversation(conversationId: string) {
  ensureDatabase();
  const { deleted, workspace } = removeConversation(conversationId);
  if (deleted && workspace) {
    try {
      fs.rmSync(workspace.rootPath, { recursive: true, force: true });
    } catch (error) {
      console.warn(`Failed to remove workspace ${workspace.rootPath}`, error);
    }
  }
  return deleted;
}

export async function sendMessage(input: SendMessageInput) {
  ensureDatabase();
  const content = input.content.trim();
  if (!content) throw new Error("Message content cannot be empty.");
  const origin = assertMessageOrigin(input.origin);
  if (origin !== "human" && (input.action || input.targetRunId)) throw new Error("Only human ingress may submit run-control actions.");

  const conversation = getConversation(input.conversationId);
  if (!conversation) throw new Error("Conversation not found.");
  if (input.action && !["discussion", "new_task", "progress", "supplement", "correction", "cancel"].includes(input.action)) throw new Error("Invalid human message action.");
  if (input.targetRunId) {
    const target = getRun(input.targetRunId);
    if (!input.action || !target || target.conversationId !== conversation.id || !conversation.agentIds.includes(target.agentId)) throw new Error("Control target is not a run in this conversation.");
  }
  const parent = input.parentMessageId ? getMessage(input.parentMessageId) : null;
  if (input.parentMessageId) {
    if (!parent || parent.conversationId !== input.conversationId) {
      throw new Error("Reply target does not belong to this conversation.");
    }
  }

  const now = Date.now();
  const mentionedAgentIds = [...new Set(input.mentionedAgentIds ?? [])];
  // Resolve before writing, so invalid explicit targets cannot silently fall
  // back to a different Agent or leave an apparently accepted message behind.
  const responderIds = origin === "human"
    ? resolveMessageRecipients(conversation, listAgents(), mentionedAgentIds, parent)
    : [];

  // Build parts: text + attachment references
  const parts: Message["parts"] = [{ type: "text", content }];
  const attachmentIds = input.attachmentIds ?? [];
  for (const attId of attachmentIds) {
    const att = resolveAttachment(attId, input.conversationId);
    if (att) {
      parts.push(
        att.kind === "image"
          ? { type: "image_attachment", attachmentId: att.id, fileName: att.fileName, size: att.size, mimeType: att.mimeType }
          : { type: "file_attachment", attachmentId: att.id, fileName: att.fileName, size: att.size, mimeType: att.mimeType }
      );
    }
  }

  const requestKey = input.clientRequestId ?? randomUUID();
  if (!requestKey.trim() || requestKey.length > 120) throw new Error("Invalid client request identity.");
  const payloadHash = createHash("sha256").update(JSON.stringify({ content, origin, mentionedAgentIds, attachmentIds,
    parentMessageId: input.parentMessageId ?? null, action: input.action ?? null, targetRunId: input.targetRunId ?? null })).digest("hex");
  const claimed = claimMessageSubmission(input.conversationId, requestKey, payloadHash, () => createMessage({
    id: newMessageId(),
    conversationId: input.conversationId,
    role: "user",
    origin,
    parts,
    status: "complete",
    mentionedAgentIds,
    parentMessageId: input.parentMessageId ?? null,
    now
  }));
  if (claimed.replay) return { message: claimed.message, ...claimed.outcome };
  const message: Message = { ...claimed.message, clientRequestId: requestKey };

  touchConversation(input.conversationId, now);
  eventBus.publish({
    type: "message.added",
    conversationId: input.conversationId,
    timestamp: now,
    message
  });

  // Check for deploy command before starting agent runs. Only a human may
  // issue one: a bot echo of a deploy-looking string must not deploy.
  const deployIntent = origin === "human" ? detectDeployCommand(content) : null;
  if (deployIntent) {
    try {
      const deploy = await handleDeployCommand(input.conversationId, deployIntent);
      const outcome = { runIds: [] as string[], deploy };
      finishMessageSubmission(input.conversationId, requestKey, outcome);
      return { message, ...outcome };
    } catch (error) { finishMessageSubmission(input.conversationId, requestKey, null); throw error; }
  }

  const handles = responderIds.map((agentId) =>
    startAgentRun({
      conversationId: input.conversationId,
      agentId,
      triggerMessage: message,
      humanTurn: { action: input.action, targetRunId: input.targetRunId },
    })
  );

  const outcome = { runIds: handles.map((h) => h.runId) };
  finishMessageSubmission(input.conversationId, requestKey, outcome);
  return { message, ...outcome };
}

/**
 * The type makes `origin` required, but that only constrains TypeScript
 * callers. A caller that bypasses the type — or arrives from untyped code —
 * would otherwise have `createMessage` fall back to the role default and write
 * 'human' while ingress refuses to dispatch, producing a row that
 * says human but behaves as though it were not. Fail loudly instead, before
 * anything is written.
 */
function assertMessageOrigin(value: unknown): MessageOrigin {
  if (value === "human" || value === "bot" || value === "internal") return value;
  throw new Error("sendMessage requires an explicit origin of human, bot, or internal.");
}

/**
 * Give a conversation a workspace.
 *
 * Exported because a conversation can also be discovered rather than created by
 * hand — a channel chat that speaks for the first time — and that path has to
 * produce the same thing. Without a workspace every run in the conversation
 * fails immediately with "Workspace not found", which is exactly what happened
 * the first time this was exercised for real.
 */
export function createWorkspace(conversationId: string, now: number) {
  const workspaceId = newWorkspaceId();
  const workspaceRoot = path.join(getDataDir(), "workspaces", conversationId);
  fs.mkdirSync(workspaceRoot, { recursive: true });

  getDatabase()
    .prepare(
      `
        INSERT INTO workspaces (
          id, conversation_id, mode, root_path, bound_path, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `
    )
    .run(workspaceId, conversationId, "sandbox", workspaceRoot, null, now, now);
}

async function handleDeployCommand(conversationId: string, intent: { artifactId?: string }) {
  // If specific artifact requested, deploy it directly
  if (intent.artifactId) {
    const result = deployArtifact(intent.artifactId, conversationId);
    const msg = createMessage({
      id: newMessageId(),
      conversationId,
      role: "system",
      parts: [{
        type: "deploy_status",
        deployment: result
      }],
      status: "complete",
      now: Date.now()
    });
    eventBus.publish({ type: "message.added", conversationId, timestamp: Date.now(), message: msg });
    return { deployed: true, artifactId: intent.artifactId, status: result.status };
  }

  // No specific artifact — find candidates
  const artifacts = listArtifacts(conversationId).filter((a) => a.type === "web_app");
  if (artifacts.length === 0) {
    const msg = createMessage({
      id: newMessageId(), conversationId, role: "system",
      parts: [{ type: "text", content: "当前会话没有可部署的 web_app 产物。先让 Agent 创建一个吧。" }],
      status: "complete", now: Date.now()
    });
    eventBus.publish({ type: "message.added", conversationId, timestamp: Date.now(), message: msg });
    return { deployed: false, reason: "No web_app artifacts" };
  }

  if (artifacts.length === 1) {
    const result = deployArtifact(artifacts[0].id, conversationId);
    const msg = createMessage({
      id: newMessageId(), conversationId, role: "system",
      parts: [{ type: "deploy_status", deployment: result }],
      status: "complete", now: Date.now()
    });
    eventBus.publish({ type: "message.added", conversationId, timestamp: Date.now(), message: msg });
    return { deployed: true, artifactId: artifacts[0].id, status: result.status };
  }

  // Multiple candidates — show selection
  const candidates = artifacts.map((a) => ({
    artifactId: a.id, title: a.title, version: a.version,
    createdByAgentId: a.createdByAgentId, createdAt: a.createdAt
  }));
  const msg = createMessage({
    id: newMessageId(), conversationId, role: "system",
    parts: [{ type: "deploy_candidates", candidates }],
    status: "complete", now: Date.now()
  });
  eventBus.publish({ type: "message.added", conversationId, timestamp: Date.now(), message: msg });
  return { deployed: false, candidates };
}

export async function deployConversationArtifact(conversationId: string, artifactId: string) {
  const conversation = getConversation(conversationId);
  if (!conversation) throw new Error("Conversation not found.");
  const artifact = listArtifacts(conversationId).find((item) => item.id === artifactId);
  if (!artifact) throw new Error("Artifact not found in this conversation.");
  if (artifact.type !== "web_app") throw new Error("Only web_app artifacts can be deployed.");
  const deploy = await handleDeployCommand(conversationId, { artifactId });
  return deploy;
}

function detectDeployCommand(content: string): { artifactId?: string } | null {
  const trimmed = content.trim();
  // Match: /deploy, 部署, 发布, 上线, /deploy art_xxx
  const deployMatch = trimmed.match(/^(\/deploy|部署|发布|上线)(?:\s+(art_\w+))?$/);
  if (deployMatch) {
    return { artifactId: deployMatch[2] || undefined };
  }
  return null;
}

function resolveAttachment(attachmentId: string, conversationId: string): { id: string; kind: string; fileName: string; size: number; mimeType: string } | null {
  try {
    const row = getDatabase()
      .prepare("SELECT * FROM attachments WHERE id = ? AND conversation_id = ?")
      .get(attachmentId, conversationId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      id: row.id as string,
      kind: row.kind as string,
      fileName: row.file_name as string,
      size: row.size as number,
      mimeType: row.mime_type as string
    };
  } catch {
    return null;
  }
}

function validateConversationAgents(mode: "single" | "group", agentIds: string[], agents: Agent[]) {
  if (mode === "single" && agentIds.length !== 1) {
    throw new Error("Single conversation requires exactly one agent.");
  }
  if (mode === "group" && agentIds.length < 2) {
    throw new Error("Group conversation requires at least two agents.");
  }

  const existingIds = new Set(agents.map((agent) => agent.id));
  const missingId = agentIds.find((agentId) => !existingIds.has(agentId));
  if (missingId) {
    throw new Error(`Unknown agent: ${missingId}`);
  }

  const conductorCount = agentIds.filter((agentId) =>
    agents.some((agent) => agent.id === agentId && agent.isConductor)
  ).length;
  if (conductorCount > 1) {
    throw new Error("Group conversation can include at most one Conductor.");
  }
}
