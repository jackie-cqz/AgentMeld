import { getDatabase } from "@/db/client";
import type { SearchHit } from "@/shared/types";

export interface SearchOptions {
  query: string;
  limit?: number;
  offset?: number;
  conversationId?: string;
  role?: "user" | "agent";
  fallback?: "like";
}

export interface SearchResult {
  hits: SearchHit[];
  total: number;
  tookMs: number;
  mode: "fts" | "like";
  error?: "INVALID_QUERY";
}

interface SearchRow {
  message_id: string;
  conversation_id: string;
  conversation_title: string;
  role: SearchHit["role"];
  agent_id: string | null;
  agent_name: string | null;
  agent_avatar: string | null;
  created_at: number;
  snippet_html: string | null;
}

export function searchMessages(options: SearchOptions): SearchResult {
  const startedAt = performance.now();
  const query = options.query.trim();
  if (!query) {
    return { hits: [], total: 0, tookMs: 0, mode: options.fallback === "like" ? "like" : "fts" };
  }

  const limit = Math.min(Math.max(options.limit ?? 20, 1), 100);
  const offset = Math.max(options.offset ?? 0, 0);
  const useLike = options.fallback === "like";

  try {
    const result = useLike
      ? searchWithLike(query, limit, offset, options)
      : searchWithFts(query, limit, offset, options);
    return {
      ...result,
      tookMs: Math.max(0, Math.round((performance.now() - startedAt) * 100) / 100),
      mode: useLike ? "like" : "fts"
    };
  } catch {
    if (!useLike && !isFtsAvailable()) {
      const result = searchWithLike(query, limit, offset, options);
      return {
        ...result,
        tookMs: Math.max(0, Math.round((performance.now() - startedAt) * 100) / 100),
        mode: "like"
      };
    }
    return {
      hits: [],
      total: 0,
      tookMs: Math.max(0, Math.round((performance.now() - startedAt) * 100) / 100),
      mode: useLike ? "like" : "fts",
      error: "INVALID_QUERY"
    };
  }
}

function searchWithFts(
  query: string,
  limit: number,
  offset: number,
  options: SearchOptions
): Pick<SearchResult, "hits" | "total"> {
  const ftsQuery = buildFtsQuery(query);
  const filters = buildFilters(options);
  const db = getDatabase();
  const rows = db.prepare(`
    SELECT
      m.id AS message_id,
      m.conversation_id,
      c.title AS conversation_title,
      m.role,
      m.agent_id,
      a.name AS agent_name,
      a.avatar AS agent_avatar,
      m.created_at,
      snippet(messages_fts, 0, '<mark>', '</mark>', '…', 18) AS snippet_html
    FROM messages_fts
    JOIN messages m ON m.rowid = messages_fts.rowid
    JOIN conversations c ON c.id = m.conversation_id
    LEFT JOIN agents a ON a.id = m.agent_id
    WHERE messages_fts MATCH ?
      ${filters.sql}
    ORDER BY bm25(messages_fts), m.created_at DESC
    LIMIT ? OFFSET ?
  `).all(ftsQuery, ...filters.params, limit, offset) as SearchRow[];

  const count = db.prepare(`
    SELECT COUNT(*) AS count
    FROM messages_fts
    JOIN messages m ON m.rowid = messages_fts.rowid
    WHERE messages_fts MATCH ?
      ${filters.sql}
  `).get(ftsQuery, ...filters.params) as { count: number };

  return { hits: rows.map(mapSearchRow), total: count.count };
}

function searchWithLike(
  query: string,
  limit: number,
  offset: number,
  options: SearchOptions
): Pick<SearchResult, "hits" | "total"> {
  const filters = buildFilters(options);
  const db = getDatabase();
  const pattern = `%${escapeLike(query)}%`;
  const rows = db.prepare(`
    SELECT
      m.id AS message_id,
      m.conversation_id,
      c.title AS conversation_title,
      m.role,
      m.agent_id,
      a.name AS agent_name,
      a.avatar AS agent_avatar,
      m.created_at,
      (
        SELECT json_extract(j.value, '$.content')
        FROM json_each(m.parts) AS j
        WHERE json_extract(j.value, '$.type') = 'text'
          AND json_extract(j.value, '$.content') LIKE ? ESCAPE '\\'
        LIMIT 1
      ) AS snippet_html
    FROM messages m
    JOIN conversations c ON c.id = m.conversation_id
    LEFT JOIN agents a ON a.id = m.agent_id
    WHERE m.status != 'streaming'
      AND EXISTS (
        SELECT 1
        FROM json_each(m.parts) AS j
        WHERE json_extract(j.value, '$.type') = 'text'
          AND json_extract(j.value, '$.content') LIKE ? ESCAPE '\\'
      )
      ${filters.sql}
    ORDER BY m.created_at DESC
    LIMIT ? OFFSET ?
  `).all(pattern, pattern, ...filters.params, limit, offset) as SearchRow[];

  const count = db.prepare(`
    SELECT COUNT(*) AS count
    FROM messages m
    WHERE m.status != 'streaming'
      AND EXISTS (
        SELECT 1
        FROM json_each(m.parts) AS j
        WHERE json_extract(j.value, '$.type') = 'text'
          AND json_extract(j.value, '$.content') LIKE ? ESCAPE '\\'
      )
      ${filters.sql}
  `).get(pattern, ...filters.params) as { count: number };

  return { hits: rows.map((row) => ({ ...mapSearchRow(row), snippetHtml: trimSnippet(row.snippet_html ?? "", query) })), total: count.count };
}

function buildFilters(options: SearchOptions): { sql: string; params: string[] } {
  const clauses: string[] = [];
  const params: string[] = [];
  if (options.conversationId) {
    clauses.push("m.conversation_id = ?");
    params.push(options.conversationId);
  }
  if (options.role) {
    clauses.push("m.role = ?");
    params.push(options.role);
  }
  return {
    sql: clauses.length > 0 ? `AND ${clauses.join(" AND ")}` : "",
    params
  };
}

function buildFtsQuery(query: string): string {
  if (query.includes("(") || query.includes(")")) {
    throw new Error("Invalid FTS query.");
  }
  if (query.includes("-") && !(query.startsWith('"') && query.endsWith('"'))) {
    return `"${query.replaceAll('"', '""')}"`;
  }
  if (/^[\p{L}\p{N}_]+(?:\*)?$/u.test(query)) return query;
  if (query.startsWith('"') && query.endsWith('"')) return query;
  return query
    .split(/\s+/)
    .filter(Boolean)
    .map((term) => term.endsWith("*") && /^[\p{L}\p{N}_]+\*$/u.test(term)
      ? term
      : `"${term.replaceAll('"', '""')}"`)
    .join(" ");
}

function escapeLike(query: string): string {
  return query.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
}

function trimSnippet(content: string, query: string): string {
  const normalized = content.replace(/\s+/g, " ").trim();
  const index = normalized.toLocaleLowerCase().indexOf(query.toLocaleLowerCase());
  if (index < 0 || normalized.length <= 160) return normalized;
  const start = Math.max(0, index - 60);
  const end = Math.min(normalized.length, index + query.length + 80);
  return `${start > 0 ? "…" : ""}${normalized.slice(start, end)}${end < normalized.length ? "…" : ""}`;
}

function mapSearchRow(row: SearchRow): SearchHit {
  return {
    messageId: row.message_id,
    conversationId: row.conversation_id,
    conversationTitle: row.conversation_title,
    role: row.role,
    agentId: row.agent_id,
    agentName: row.agent_name,
    agentAvatar: row.agent_avatar,
    createdAt: row.created_at,
    snippetHtml: row.snippet_html ?? ""
  };
}

function isFtsAvailable(): boolean {
  try {
    getDatabase().prepare("SELECT rowid FROM messages_fts LIMIT 1").all();
    return true;
  } catch {
    return false;
  }
}
