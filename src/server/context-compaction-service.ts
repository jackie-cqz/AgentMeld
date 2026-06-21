import { getDatabase } from "@/db/client";
import { getConversation, listMessages, listArtifacts } from "@/server/repositories";
import { estimateTokens } from "@/shared/token-estimate";
import type { Message } from "@/shared/types";

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
    } else {
      // P0: Boundary message not found — explicit failure, don't silently re-compact
      return { sourceMessages: [], coveredUntilMessageId: "", coveredUntilCreatedAt: 0, keptRecent: [], blockingReason: `summary_boundary_missing: 摘要覆盖的消息 "${summary.coveredUntilMessageId}" 在当前会话中未找到。请手动重新压缩。` };
    }
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

    // P2: Split oversized single messages by paragraph boundaries
    if (msgTokens > CHUNK_TARGET_TOKENS) {
      if (currentChunk.length > 0) {
        chunks.push({
          messages: currentChunk, startMessageId: currentChunk[0].id,
          endMessageId: currentChunk[currentChunk.length - 1].id, estimatedTokens: currentTokens
        });
        currentChunk = []; currentTokens = 0;
      }
      // Split serialized content by paragraphs, each fragment carries _overrideContent
      const parts = serialized.split("\n\n");
      let partialChunk: Message[] = [];
      let partialTokens = 0;
      for (const part of parts) {
        const partTokens = estimateTokens(part);
        if (partialTokens + partTokens > CHUNK_TARGET_TOKENS && partialChunk.length > 0) {
          chunks.push({
            messages: partialChunk, startMessageId: partialChunk[0].id,
            endMessageId: partialChunk[partialChunk.length - 1].id, estimatedTokens: partialTokens
          });
          partialChunk = []; partialTokens = 0;
        }
        // Fragment carries the actual split content via parts override
        const fragment: Message = { ...msg, parts: [{ type: "text" as const, content: part }] };
        partialChunk.push(fragment);
        partialTokens += partTokens;
      }
      if (partialChunk.length > 0) { currentChunk = partialChunk; currentTokens = partialTokens; }
      continue;
    }

    if (currentTokens + msgTokens >= CHUNK_TARGET_TOKENS && currentChunk.length > 0) {
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

// ---------------------------------------------------------------------------
// P1: Compaction job persistence
// ---------------------------------------------------------------------------

export interface CompactionJob {
  id: string;
  conversationId: string;
  status: "queued" | "running" | "complete" | "failed" | "aborted" | "interrupted";
  baseSummaryId: string | null;
  previousJobId: string | null;
  resultSummaryId: string | null;
  sourceStartMessageId: string;
  sourceEndMessageId: string;
  sourceMessageCount: number;
  chunkCount: number;
  completedChunkCount: number;
  modelProvider: string;
  modelId: string;
  attempt: number;
  errorCategory: string | null;
  error: string | null;
  retryable: boolean;
  startedAt: number | null;
  finishedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

function mapCompactionJob(row: Record<string, unknown>): CompactionJob {
  return {
    id: row.id as string,
    conversationId: row.conversation_id as string,
    status: row.status as CompactionJob["status"],
    baseSummaryId: (row.base_summary_id as string) ?? null,
    previousJobId: (row.previous_job_id as string) ?? null,
    resultSummaryId: (row.result_summary_id as string) ?? null,
    sourceStartMessageId: row.source_start_message_id as string,
    sourceEndMessageId: row.source_end_message_id as string,
    sourceMessageCount: row.source_message_count as number,
    chunkCount: row.chunk_count as number,
    completedChunkCount: row.completed_chunk_count as number,
    modelProvider: row.model_provider as string,
    modelId: row.model_id as string,
    attempt: row.attempt as number,
    errorCategory: (row.error_category as string) ?? null,
    error: (row.error as string) ?? null,
    retryable: (row.retryable as number) === 1,
    startedAt: (row.started_at as number) ?? null,
    finishedAt: (row.finished_at as number) ?? null,
    createdAt: row.created_at as number,
    updatedAt: row.updated_at as number
  };
}

export function createCompactionJob(
  id: string,
  conversationId: string,
  sourceStartMessageId: string,
  sourceEndMessageId: string,
  sourceMessageCount: number,
  chunkCount: number,
  modelProvider: string,
  modelId: string,
  now: number,
  options?: {
    baseSummaryId?: string | null;
    previousJobId?: string | null;
    attempt?: number;
  }
): CompactionJob | string {
  const db = getDatabase();
  // P1: Same-conversation concurrency lock via conditional INSERT
  const existing = getActiveCompactionJob(conversationId);
  if (existing) return `已有进行中的压缩任务（${existing.id}），请等待完成后再试。`;

  db.prepare(`
    INSERT INTO context_compaction_jobs (
      id, conversation_id, status, base_summary_id, previous_job_id,
      source_start_message_id, source_end_message_id, source_message_count,
      chunk_count, model_provider, model_id, attempt, created_at, updated_at
    ) VALUES (?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    conversationId,
    options?.baseSummaryId ?? null,
    options?.previousJobId ?? null,
    sourceStartMessageId,
    sourceEndMessageId,
    sourceMessageCount,
    chunkCount,
    modelProvider,
    modelId,
    options?.attempt ?? 1,
    now,
    now
  );

  return getCompactionJob(id) as CompactionJob;
}

export function startCompactionJob(jobId: string, now: number): boolean {
  const db = getDatabase();
  const result = db.prepare(`
    UPDATE context_compaction_jobs SET status = 'running', started_at = ?, updated_at = ?
    WHERE id = ? AND status = 'queued'
  `).run(now, now, jobId);
  return getRunChanges(result) > 0;
}

export function completeCompactionJob(jobId: string, resultSummaryId: string, now: number): boolean {
  const db = getDatabase();
  const result = db.prepare(`
    UPDATE context_compaction_jobs SET status = 'complete', result_summary_id = ?, finished_at = ?, updated_at = ?
    WHERE id = ? AND status = 'running'
  `).run(resultSummaryId, now, now, jobId);
  return getRunChanges(result) > 0;
}

export function failCompactionJob(jobId: string, errorCategory: string, error: string, retryable: boolean, now: number): boolean {
  const db = getDatabase();
  const result = db.prepare(`
    UPDATE context_compaction_jobs
    SET status = 'failed', error_category = ?, error = ?, retryable = ?, finished_at = ?, updated_at = ?
    WHERE id = ? AND status = 'running'
  `).run(errorCategory, error, retryable ? 1 : 0, now, now, jobId);
  return getRunChanges(result) > 0;
}

export function abortCompactionJob(jobId: string, now: number): boolean {
  const db = getDatabase();
  const result = db.prepare(`
    UPDATE context_compaction_jobs SET status = 'aborted', finished_at = ?, updated_at = ?
    WHERE id = ? AND status IN ('queued', 'running')
  `).run(now, now, jobId);
  return getRunChanges(result) > 0;
}

export function updateCompactionJobProgress(jobId: string, completedChunks: number, now: number): boolean {
  const db = getDatabase();
  const result = db.prepare(`
    UPDATE context_compaction_jobs SET completed_chunk_count = ?, updated_at = ?
    WHERE id = ? AND status = 'running'
  `).run(completedChunks, now, jobId);
  return getRunChanges(result) > 0;
}

export function getCompactionJob(jobId: string): CompactionJob | null {
  try {
    const row = getDatabase().prepare("SELECT * FROM context_compaction_jobs WHERE id = ?").get(jobId) as Record<string, unknown> | undefined;
    return row ? mapCompactionJob(row) : null;
  } catch { return null; }
}

export function getActiveCompactionJob(conversationId: string): CompactionJob | null {
  try {
    const row = getDatabase().prepare(
      "SELECT * FROM context_compaction_jobs WHERE conversation_id = ? AND status IN ('queued', 'running') LIMIT 1"
    ).get(conversationId) as Record<string, unknown> | undefined;
    return row ? mapCompactionJob(row) : null;
  } catch { return null; }
}

export function listCompactionJobs(conversationId: string): CompactionJob[] {
  try {
    const rows = getDatabase().prepare(
      "SELECT * FROM context_compaction_jobs WHERE conversation_id = ? ORDER BY created_at DESC LIMIT 10"
    ).all(conversationId) as Record<string, unknown>[];
    return rows.map(mapCompactionJob);
  } catch { return []; }
}

export function recoverCompactionJobs(now: number): number {
  const db = getDatabase();
  const result = db.prepare(`
    UPDATE context_compaction_jobs SET status = 'interrupted', finished_at = ?, updated_at = ?
    WHERE status IN ('queued', 'running')
  `).run(now, now);
  return getRunChanges(result);
}

function getRunChanges(result: unknown): number {
  if (typeof result !== "object" || result === null || !("changes" in result)) {
    return 0;
  }
  const changes = (result as { changes: unknown }).changes;
  return typeof changes === "bigint" ? Number(changes) : typeof changes === "number" ? changes : 0;
}

// Job store for AbortController (in-memory, not state source)
const jobControllers = new Map<string, AbortController>();

export function setCompactionJobController(jobId: string, ctrl: AbortController) {
  jobControllers.set(jobId, ctrl);
}

export function getCompactionJobController(jobId: string): AbortController | undefined {
  return jobControllers.get(jobId);
}

export function removeCompactionJobController(jobId: string) {
  jobControllers.delete(jobId);
}
