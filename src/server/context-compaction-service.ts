import { getDatabase } from "@/db/client";
import { getConversation, listMessages, listArtifacts } from "@/server/repositories";
import { estimateTokens } from "@/shared/token-estimate";
import type { Message, MessagePart } from "@/shared/types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CompactionWindow {
  /** Messages selected for compaction */
  sourceMessages: Message[];
  /** Last message covered by this compaction */
  coveredUntilMessageId: string;
  coveredUntilCreatedAt: number;
  /** Messages kept as recent (not compacted) */
  keptRecent: Message[];
  /** Why compaction can't proceed (null = can compact) */
  blockingReason: string | null;
}

export interface ChunkedMessages {
  chunks: Array<{
    messages: Message[];
    startMessageId: string;
    endMessageId: string;
    estimatedTokens: number;
  }>;
}

export interface ContextBudget {
  contextWindow: number;
  outputReserve: number;
  systemTokens: number;
  summaryTokens: number;
  pinnedTokens: number;
  recentTokens: number;
  currentTurnTokens: number;
  protocolMargin: number;
  remainingTokens: number;
}

// ---------------------------------------------------------------------------
// P0: Compaction window selection
// ---------------------------------------------------------------------------

/**
 * Select messages eligible for compaction.
 * Rules:
 *  - Only complete messages after the latest summary's covered boundary
 *  - Exclude system, pinned, and non-complete messages
 *  - Keep the last KEEP_RECENT messages as recent (not compacted)
 *  - Use messageId as primary boundary, createdAt for diagnostics only
 */
export function selectCompactionWindow(
  conversationId: string,
  keepRecent: number = 8,
  minSource: number = 3
): CompactionWindow {
  const conversation = getConversation(conversationId);
  if (!conversation) return { sourceMessages: [], coveredUntilMessageId: "", coveredUntilCreatedAt: 0, keptRecent: [], blockingReason: "Conversation not found." };

  const summary = getLatestSummary(conversationId);
  const allMessages = listMessages(conversationId)
    .filter((m) => m.status === "complete" && m.role !== "system")
    .sort((a, b) => a.createdAt - b.createdAt);

  if (allMessages.length < keepRecent + minSource) {
    return { sourceMessages: [], coveredUntilMessageId: "", coveredUntilCreatedAt: 0, keptRecent: [], blockingReason: `消息不足（共 ${allMessages.length} 条，需至少 ${keepRecent + minSource} 条）。` };
  }

  const pinnedIds = new Set(conversation.pinnedMessageIds);

  // Find messages after summary boundary
  let afterCovered = allMessages;
  if (summary) {
    const coverIdx = allMessages.findIndex((m) => m.id === summary.coveredUntilMessageId);
    if (coverIdx >= 0) {
      afterCovered = allMessages.slice(coverIdx + 1);
    }
    // If cover message not found, all messages are after it (boundary is valid)
  }

  // Exclude pinned
  const unpinnedAfterCovered = afterCovered.filter((m) => !pinnedIds.has(m.id));

  if (unpinnedAfterCovered.length < keepRecent + minSource) {
    return { sourceMessages: [], coveredUntilMessageId: "", coveredUntilCreatedAt: 0, keptRecent: unpinnedAfterCovered, blockingReason: `未压缩消息不足（${unpinnedAfterCovered.length} 条，需至少 ${keepRecent + minSource} 条）。` };
  }

  const keptRecent = unpinnedAfterCovered.slice(-keepRecent);
  const sourceMessages = unpinnedAfterCovered.slice(0, -keepRecent);
  const lastSource = sourceMessages[sourceMessages.length - 1];

  return {
    sourceMessages,
    coveredUntilMessageId: lastSource.id,
    coveredUntilCreatedAt: lastSource.createdAt,
    keptRecent,
    blockingReason: null
  };
}

// ---------------------------------------------------------------------------
// P2: Message chunking for rolling compaction
// ---------------------------------------------------------------------------

const CHUNK_TARGET_TOKENS = 10000; // ~10K tokens per chunk

/**
 * Serialize a message for compaction — full public content, no 800-char truncation.
 */
export function serializeMessageForCompaction(msg: Message, artifactTitles: Map<string, string>): string {
  const chunks: string[] = [];
  const roleLabel = msg.role === "user" ? "[用户]" : msg.agentId ? `[${msg.agentId}]` : "";
  const prefix = roleLabel ? `${roleLabel} ` : "";

  for (const p of msg.parts) {
    if (p.type === "text") { chunks.push(p.content); }
    else if (p.type === "artifact_ref") {
      const title = artifactTitles.get(p.artifactId) ?? p.artifactId;
      chunks.push(`[产物: ${title} (id=${p.artifactId})]`);
    }
    else if (p.type === "deploy_status") {
      chunks.push(`[部署: ${p.deployment.title} → ${p.deployment.status}]`);
    }
    else if (p.type === "tool_use") {
      // Lightweight: just the tool name + brief args summary
      const args = p.args as Record<string, unknown> | undefined;
      const brief = args?.path ? `path=${args.path}` : args?.command ? `cmd=${args.command}` : "";
      chunks.push(`[工具: ${p.toolName}${brief ? " " + brief : ""}]`);
    }
    // Drop: thinking, tool_result (full content), image/file attachments
  }

  const text = chunks.join("\n").trim();
  return text ? `${prefix}${text}` : "";
}

/**
 * Split messages into chunks suitable for LLM compaction.
 * Does NOT truncate individual messages. Respects message boundaries.
 */
export function chunkCompactionMessages(messages: Message[], artifactTitles: Map<string, string>): ChunkedMessages {
  const chunks: ChunkedMessages["chunks"] = [];
  let currentChunk: Message[] = [];
  let currentTokens = 0;

  for (const msg of messages) {
    const serialized = serializeMessageForCompaction(msg, artifactTitles);
    const msgTokens = estimateTokens(serialized);

    // If a single message exceeds chunk target, keep it as its own chunk
    if (msgTokens > CHUNK_TARGET_TOKENS && currentChunk.length > 0) {
      chunks.push({
        messages: currentChunk,
        startMessageId: currentChunk[0].id,
        endMessageId: currentChunk[currentChunk.length - 1].id,
        estimatedTokens: currentTokens
      });
      currentChunk = [];
      currentTokens = 0;
    }

    currentChunk.push(msg);
    currentTokens += msgTokens;

    if (currentTokens >= CHUNK_TARGET_TOKENS) {
      chunks.push({
        messages: currentChunk,
        startMessageId: currentChunk[0].id,
        endMessageId: currentChunk[currentChunk.length - 1].id,
        estimatedTokens: currentTokens
      });
      currentChunk = [];
      currentTokens = 0;
    }
  }

  // Final chunk
  if (currentChunk.length > 0) {
    chunks.push({
      messages: currentChunk,
      startMessageId: currentChunk[0].id,
      endMessageId: currentChunk[currentChunk.length - 1].id,
      estimatedTokens: currentTokens
    });
  }

  return { chunks };
}

// ---------------------------------------------------------------------------
// P0: Boundary validation
// ---------------------------------------------------------------------------

/**
 * Validate that a new summary's covered boundary advances monotonically.
 * Returns null if valid, or an error string.
 */
export function validateSummaryBoundary(
  conversationId: string,
  newCoveredUntilMessageId: string
): string | null {
  const existing = getLatestSummary(conversationId);
  if (!existing) return null; // First summary, always valid

  const messages = listMessages(conversationId).sort((a, b) => a.createdAt - b.createdAt);
  const existingIdx = messages.findIndex((m) => m.id === existing.coveredUntilMessageId);
  const newIdx = messages.findIndex((m) => m.id === newCoveredUntilMessageId);

  if (newIdx < 0) return `Covered message "${newCoveredUntilMessageId}" not found in conversation.`;
  if (existingIdx >= 0 && newIdx <= existingIdx) {
    return `New summary boundary (message "${newCoveredUntilMessageId}") must be after existing boundary (message "${existing.coveredUntilMessageId}").`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// P1: Context budget calculation
// ---------------------------------------------------------------------------

export function calculateContextBudget(
  contextWindow: number,
  outputReserve: number,
  systemTokens: number,
  summaryTokens: number,
  pinnedTokens: number,
  currentTurnTokens: number
): ContextBudget {
  const protocolMargin = 128; // JSON overhead, system framing, etc.
  const fixedTotal = systemTokens + summaryTokens + pinnedTokens + currentTurnTokens + protocolMargin + outputReserve;
  const remainingTokens = Math.max(0, contextWindow - fixedTotal);

  return {
    contextWindow,
    outputReserve,
    systemTokens,
    summaryTokens,
    pinnedTokens,
    recentTokens: remainingTokens, // initial: all remaining goes to recent
    currentTurnTokens,
    protocolMargin,
    remainingTokens
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function getLatestSummary(conversationId: string): {
  id: string;
  summary: string;
  coveredUntilMessageId: string;
  coveredUntilCreatedAt: number;
  sourceMessageCount: number;
} | null {
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
  } catch { return null; }
}

export function getArtifactTitleMap(conversationId: string): Map<string, string> {
  const map = new Map<string, string>();
  try {
    for (const art of listArtifacts(conversationId)) {
      map.set(art.id, art.title);
    }
  } catch { /* ignore */ }
  return map;
}
