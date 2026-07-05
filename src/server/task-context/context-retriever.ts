// ---------------------------------------------------------------------------
// P8: Context Retriever — FTS5-based relevance search for Optional layer.
//
// Results are ALWAYS trust-level "retrieved" and can only enter the Optional
// context budget. They must NEVER override authoritative/verified/active Facts.
//
// Lazy FTS rebuild: if the FTS index is empty for this conversation,
// retrieveContext automatically triggers a rebuild before searching.
// ---------------------------------------------------------------------------

import { getDatabase } from "@/db/client";
import type { EvidenceTrustLevel } from "@/shared/evidence-types";
import { rebuildAllFts } from "@/server/search/context-fts-index";

// ── Types ───────────────────────────────────────────────────────────────────

export interface RetrievalCandidate {
  id: string;
  sourceType: "message" | "task_result" | "artifact" | "evidence" | "verdict";
  sourceId: string;
  conversationId: string;
  taskId: string;
  textContent: string;
  snippet: string; // relevant excerpt with match highlighted context
  rank: number;    // lower = more relevant
  trustLevel: EvidenceTrustLevel; // always "retrieved" for FTS results
  createdAt: number;
}

export interface RetrievalOptions {
  conversationId: string;
  query: string;
  maxResults?: number;
  /** Limit to results relevant to a specific task */
  taskId?: string;
  /** Exclude these source IDs (e.g., already-included items) */
  excludeSourceIds?: string[];
}

// ── Search ──────────────────────────────────────────────────────────────────

/**
 * Search FTS5 indexes for context relevant to the given query.
 * Searches both message content and task/evidence/verdict metadata.
 */
/** P8: Ensure FTS indexes are populated for this conversation before searching. */
function ensureFtsReady(conversationId: string): void {
  const db = getDatabase();
  try {
    const msgCount = (db
      .prepare("SELECT COUNT(*) AS cnt FROM context_fts_messages WHERE conversation_id = ?")
      .get(conversationId) as { cnt: number } | undefined)?.cnt ?? 0;
    const taskCount = (db
      .prepare("SELECT COUNT(*) AS cnt FROM context_fts_tasks WHERE conversation_id = ?")
      .get(conversationId) as { cnt: number } | undefined)?.cnt ?? 0;
    // Rebuild if EITHER index is empty — messages might be populated from
    // an earlier rebuild but tasks/evidence/verdicts could still be stale.
    if (msgCount === 0 || taskCount === 0) {
      rebuildAllFts(conversationId);
    }
  } catch {
    // FTS tables may not exist yet — try to create + rebuild
    try { rebuildAllFts(conversationId); } catch { /* best-effort */ }
  }
}

export function retrieveContext(options: RetrievalOptions): RetrievalCandidate[] {
  const { conversationId, query, maxResults = 20, taskId, excludeSourceIds = [] } = options;
  const db = getDatabase();
  const excludeSet = new Set(excludeSourceIds);
  const results: RetrievalCandidate[] = [];

  const normalizedQuery = query.trim().slice(0, 500);
  if (!normalizedQuery) return [];

  // Escape FTS5 special characters but keep meaningful terms
  const safeQuery = normalizedQuery.replace(/["*()]/g, " ").replace(/\s+/g, " ").trim();
  if (!safeQuery) return [];

  // P8: Lazy FTS rebuild — if empty, rebuild before searching
  ensureFtsReady(conversationId);

  // Over-fetch to account for taskId filtering in JS (we want maxResults
  // AFTER task filtering, so fetch more than we need).
  const fetchLimit = taskId ? maxResults * 4 : maxResults;

  try {
    // ── Search messages ──────────────────────────────────────────────────
    const msgRows = db
      .prepare(`
        SELECT message_id, role, agent_name, text_content, created_at,
               rank
        FROM context_fts_messages
        WHERE context_fts_messages MATCH ?
          AND conversation_id = ?
        ORDER BY rank
        LIMIT ?
      `)
      .all(safeQuery, conversationId, fetchLimit) as Array<{
        message_id: string; role: string; agent_name: string;
        text_content: string; created_at: number; rank: number;
      }>;

    for (const row of msgRows) {
      if (excludeSet.has(row.message_id)) continue;
      results.push({
        id: `ret_msg_${row.message_id}`,
        sourceType: "message",
        sourceId: row.message_id,
        conversationId,
        taskId: "",
        textContent: row.text_content.slice(0, 1000),
        snippet: buildSnippet(row.text_content, safeQuery, 200),
        rank: row.rank,
        trustLevel: "retrieved",
        createdAt: row.created_at,
      });
    }

    // ── Search tasks/evidence/verdicts ────────────────────────────────────
    // P8: Push taskId filter into SQL WHERE to avoid truncation before filtering.
    const taskWhere = taskId
      ? "AND (task_id = ? OR task_id = '')"
      : "";
    const taskParams = taskId
      ? [safeQuery, conversationId, taskId, fetchLimit]
      : [safeQuery, conversationId, fetchLimit];

    const taskRows = db
      .prepare(`
        SELECT source_type, source_id, task_id, text_content, created_at,
               rank
        FROM context_fts_tasks
        WHERE context_fts_tasks MATCH ?
          AND conversation_id = ?
          ${taskWhere}
        ORDER BY rank
        LIMIT ?
      `)
      .all(...taskParams) as Array<{
        source_type: string; source_id: string; task_id: string;
        text_content: string; created_at: number; rank: number;
      }>;

    for (const row of taskRows) {
      if (excludeSet.has(row.source_id)) continue;
      results.push({
        id: `ret_task_${row.source_id}`,
        sourceType: row.source_type as RetrievalCandidate["sourceType"],
        sourceId: row.source_id,
        conversationId,
        taskId: row.task_id,
        textContent: row.text_content.slice(0, 1000),
        snippet: buildSnippet(row.text_content, safeQuery, 200),
        rank: row.rank + 0.5, // slight penalty vs message matches
        trustLevel: "retrieved",
        createdAt: row.created_at,
      });
    }
  } catch {
    // FTS5 may not be initialized yet — return empty
    return [];
  }

  // Sort by rank (lower = better), then recency
  results.sort((a, b) => a.rank - b.rank || b.createdAt - a.createdAt);

  return results.slice(0, maxResults);
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function buildSnippet(text: string, query: string, maxLen: number): string {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const lower = text.toLowerCase();
  let bestPos = 0;

  for (const term of terms) {
    const idx = lower.indexOf(term);
    if (idx >= 0) {
      bestPos = Math.max(0, idx - 40);
      break;
    }
  }

  let snippet = text.slice(bestPos, bestPos + maxLen);
  if (bestPos > 0) snippet = "…" + snippet;
  if (bestPos + maxLen < text.length) snippet = snippet + "…";
  return snippet;
}
