import { getConversation, getMessage, listArtifacts, listMessages } from "@/server/repositories";
import { getDatabase } from "@/db/client";
import { estimateTokens } from "@/shared/token-estimate";
import type { Artifact, Message, MessagePart } from "@/shared/types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_call_id?: string;
  name?: string;
}

export interface BuildHistoryOptions {
  maxTurns?: number;
  includePinned?: boolean;
  excludeMessageId?: string;
  tokenBudget?: number;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function buildHistoryFor(
  agentId: string,
  conversationId: string,
  options?: BuildHistoryOptions
): Promise<ChatMessage[]> {
  const maxTurns = options?.maxTurns ?? 20;
  const includePinned = options?.includePinned ?? true;
  const excludeMessageId = options?.excludeMessageId;

  // 1. Read conversation + context summary
  const conversation = getConversation(conversationId);
  if (!conversation) return [];

  const isGroup = conversation.agentIds.length > 1;
  const summary = getLatestContextSummary(conversationId);

  // 2. Get recent complete messages (after summary covered range if exists)
  const allMessages = listMessages(conversationId).filter(
    (m) => m.status === "complete" && m.id !== excludeMessageId
  );

  // If summary exists, only include messages after the covered range
  const afterCovered = summary
    ? allMessages.filter((m) => m.createdAt > summary.coveredUntilCreatedAt)
    : allMessages;

  // 3. Split recent + pinned
  const pinnedIds = includePinned ? new Set(conversation.pinnedMessageIds) : new Set<string>();
  const recentMessages = afterCovered
    .filter((m) => !pinnedIds.has(m.id))
    .slice(-maxTurns);

  const pinnedMessages = includePinned
    ? allMessages.filter((m) => pinnedIds.has(m.id)) // pinned always from full range
    : [];

  // 4. Merge, dedupe, sort by createdAt
  const byId = new Map<string, Message>();
  for (const m of recentMessages) byId.set(m.id, m);
  for (const m of pinnedMessages) byId.set(m.id, m);
  const merged = Array.from(byId.values()).sort((a, b) => a.createdAt - b.createdAt);

  // 5. Get all artifact titles in one query
  const artifactIds = new Set<string>();
  for (const m of merged) {
    for (const p of m.parts) {
      if (p.type === "artifact_ref") artifactIds.add(p.artifactId);
    }
  }
  const artifactTitles = new Map<string, string>();
  if (artifactIds.size > 0) {
    const allArtifacts = listArtifacts(conversationId);
    for (const art of allArtifacts) {
      if (artifactIds.has(art.id)) {
        artifactTitles.set(art.id, art.title);
      }
    }
  }

  // 6. Serialize to ChatMessage[]
  const items: Array<{ pinned: boolean; messages: ChatMessage[]; tokens: number }> = [];
  for (const msg of merged) {
    const serialized = serializeMessage(msg, agentId, isGroup, artifactTitles);
    if (serialized.length === 0) continue;
    const tokens = serialized.reduce((sum, m) => sum + estimateTokens(m.content), 0);
    items.push({
      pinned: pinnedIds.has(msg.id),
      messages: serialized,
      tokens
    });
  }

  // 7. Token budget truncation
  const budget = options?.tokenBudget;
  if (budget && budget > 0) {
    let totalTokens = items.reduce((s, it) => s + it.tokens, 0);
    // Drop oldest non-pinned items first
    for (let i = 0; i < items.length && totalTokens > budget; i++) {
      if (items[i].pinned) continue;
      totalTokens -= items[i].tokens;
      items[i] = { ...items[i], tokens: -1 }; // mark as dropped
    }
  }

  // 8. Flatten — summary goes first, then history
  const result: ChatMessage[] = [];

  // Inject context summary as first user message (durable context)
  if (summary) {
    result.push({
      role: "user",
      content: `<conversation_summary covered_until="${summary.coveredUntilMessageId}">\n${summary.summary}\n</conversation_summary>`
    });
  }

  for (const item of items) {
    if (item.tokens < 0) continue;
    result.push(...item.messages);
  }

  return result;
}

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

function serializeMessage(
  msg: Message,
  currentAgentId: string,
  isGroup: boolean,
  artifactTitles: Map<string, string>
): ChatMessage[] {
  if (msg.role === "system") return [];

  if (msg.role === "user") {
    const text = renderUserText(msg.parts);
    if (!text) return [];
    return [{ role: "user", content: text }];
  }

  // Agent message
  const isSelf = msg.agentId === currentAgentId;
  const text = renderAgentPublicText(msg.parts, artifactTitles);
  if (!text) return [];

  if (isSelf) {
    return [{ role: "assistant", content: text }];
  }

  // Other agent in group chat
  if (isGroup) {
    const agentName = msg.agentId ?? "Agent";
    return [{ role: "user", content: `[${agentName}] ${text}` }];
  }

  return [];
}

function renderUserText(parts: MessagePart[]): string {
  const chunks: string[] = [];
  for (const p of parts) {
    if (p.type === "text") {
      chunks.push(p.content);
    } else if (p.type === "image_attachment") {
      chunks.push(`[图片附件: ${p.fileName}]`);
    } else if (p.type === "file_attachment") {
      chunks.push(`[文件附件: ${p.fileName}]`);
    }
  }
  return chunks.join("\n").trim();
}

function renderAgentPublicText(
  parts: MessagePart[],
  artifactTitles: Map<string, string>
): string {
  const chunks: string[] = [];
  for (const p of parts) {
    if (p.type === "text") {
      chunks.push(p.content);
    } else if (p.type === "code") {
      chunks.push(p.content);
    } else if (p.type === "artifact_ref") {
      const title = artifactTitles.get(p.artifactId) ?? `art_unknown`;
      chunks.push(`[产物: ${title} (id=${p.artifactId})]`);
    } else if (p.type === "deploy_status") {
      const dep = p.deployment;
      if (dep.status === "failed") {
        chunks.push(`[部署失败: ${dep.error ?? "unknown error"}]`);
      } else {
        chunks.push(`[部署预览: ${dep.title} (${dep.previewPath})]`);
      }
    }
    // Drop: thinking, tool_use, tool_result
  }
  return chunks.join("\n").trim();
}

interface ContextSummary {
  id: string;
  summary: string;
  coveredUntilMessageId: string;
  coveredUntilCreatedAt: number;
  sourceMessageCount: number;
}

function getLatestContextSummary(conversationId: string): ContextSummary | null {
  try {
    const row = getDatabase()
      .prepare("SELECT * FROM conversation_context_summaries WHERE conversation_id = ? ORDER BY created_at DESC LIMIT 1")
      .get(conversationId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      id: row.id as string,
      summary: row.summary as string,
      coveredUntilMessageId: row.covered_until_message_id as string,
      coveredUntilCreatedAt: row.covered_until_created_at as number,
      sourceMessageCount: row.source_message_count as number
    };
  } catch {
    return null;
  }
}
