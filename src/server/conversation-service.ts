import fs from "node:fs";
import path from "node:path";
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
import type { Agent, Conversation, FsWriteApprovalMode, Message } from "@/shared/types";

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
}

export function getBootstrapPayload(): BootstrapPayload {
  ensureDatabase();
  const conversations = listConversations();
  return {
    agents: listAgents(),
    conversations,
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

  const conversation = getConversation(input.conversationId);
  if (!conversation) throw new Error("Conversation not found.");
  if (input.parentMessageId) {
    const parent = getMessage(input.parentMessageId);
    if (!parent || parent.conversationId !== input.conversationId) {
      throw new Error("Reply target does not belong to this conversation.");
    }
  }

  const now = Date.now();
  const mentionedAgentIds = input.mentionedAgentIds ?? [];

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

  const message = createMessage({
    id: newMessageId(),
    conversationId: input.conversationId,
    role: "user",
    parts,
    status: "complete",
    mentionedAgentIds,
    parentMessageId: input.parentMessageId ?? null,
    now
  });

  touchConversation(input.conversationId, now);
  eventBus.publish({
    type: "message.added",
    conversationId: input.conversationId,
    timestamp: now,
    message
  });

  // Check for deploy command before starting agent runs
  const deployIntent = detectDeployCommand(content);
  if (deployIntent) {
    const deployMessage = await handleDeployCommand(input.conversationId, deployIntent);
    return {
      message,
      runIds: [],
      deploy: deployMessage
    };
  }

  const responderIds = pickResponders(conversation, mentionedAgentIds);
  const handles = responderIds.map((agentId) =>
    startAgentRun({
      conversationId: input.conversationId,
      agentId,
      triggerMessage: message
    })
  );

  return { message, runIds: handles.map((h) => h.runId) };
}

function pickResponders(conversation: Conversation, mentionedAgentIds: string[]) {
  if (conversation.mode === "single") {
    return conversation.agentIds.slice(0, 1);
  }

  const allowedMentionIds = mentionedAgentIds.filter((agentId) => conversation.agentIds.includes(agentId));
  if (allowedMentionIds.length > 0) {
    return allowedMentionIds;
  }

  const conductor = listAgents().find(
    (agent) => agent.isConductor && conversation.agentIds.includes(agent.id)
  );
  return conductor ? [conductor.id] : [];
}

function createWorkspace(conversationId: string, now: number) {
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
