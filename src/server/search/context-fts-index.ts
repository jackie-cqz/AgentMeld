// ---------------------------------------------------------------------------
// P8: Context FTS5 — full-text search for relevance-based context retrieval.
//
// FTS5 virtual tables provide fast text search over messages, task results,
// artifact metadata, evidence subjects, and verdict reasons. Results are
// surfaced to the Context Compiler's Optional layer and must NOT override
// active Facts or verified inputs.
// ---------------------------------------------------------------------------

import { getDatabase } from "@/db/client";

// ── FTS5 schema ─────────────────────────────────────────────────────────────

/**
 * Create FTS5 virtual tables. Uses content-sync mode: the FTS index
 * stores its own copy of the text so it stays consistent even if the
 * source tables change (simpler than triggers for V1).
 */
export function ensureFtsIndexes(): void {
  const db = getDatabase();

  db.exec(`
    -- P8: FTS5 index over messages (user + agent text content)
    CREATE VIRTUAL TABLE IF NOT EXISTS context_fts_messages
      USING fts5(
        message_id,
        conversation_id,
        role,
        agent_name,
        text_content,
        created_at UNINDEXED,
        tokenize='porter unicode61'
      );

    -- P8: FTS5 index over task results and evidence subjects
    CREATE VIRTUAL TABLE IF NOT EXISTS context_fts_tasks
      USING fts5(
        source_type,   -- 'task_result' | 'artifact' | 'evidence' | 'verdict'
        source_id,
        conversation_id,
        task_id,
        text_content,  -- summary / title / subject / reason
        created_at UNINDEXED,
        tokenize='porter unicode61'
      );
  `);
}

// ── Rebuild ─────────────────────────────────────────────────────────────────

export interface FtsMessageSource {
  messageId: string;
  conversationId: string;
  role: string;
  agentName: string | null;
  textContent: string;
  createdAt: number;
}

export interface FtsTaskSource {
  sourceType: "task_result" | "artifact" | "evidence" | "verdict";
  sourceId: string;
  conversationId: string;
  taskId: string;
  textContent: string;
  createdAt: number;
}

/** Rebuild the message FTS index from the messages table. */
export function rebuildMessageFts(conversationId: string): void {
  const db = getDatabase();

  // Delete existing entries for this conversation
  db.prepare("DELETE FROM context_fts_messages WHERE conversation_id = ?").run(conversationId);

  const rows = db
    .prepare(`
      SELECT m.id, m.conversation_id, m.role, m.parts, m.created_at,
             COALESCE(a.name, 'system') AS agent_name
      FROM messages m
      LEFT JOIN agents a ON m.agent_id = a.id
      WHERE m.conversation_id = ?
        AND m.status = 'complete'
      ORDER BY m.created_at ASC
    `)
    .all(conversationId) as Array<{
      id: string; conversation_id: string; role: string;
      parts: string; created_at: number; agent_name: string;
    }>;

  const insert = db.prepare(`
    INSERT INTO context_fts_messages (message_id, conversation_id, role, agent_name, text_content, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  for (const row of rows) {
    let text = "";
    try {
      const parts = JSON.parse(row.parts) as Array<{ type: string; content?: string }>;
      text = parts
        .filter((p) => p.type === "text" && p.content)
        .map((p) => p.content!)
        .join(" ");
    } catch {
      // Skip unparseable parts
    }
    if (text.trim()) {
      insert.run(row.id, row.conversation_id, row.role, row.agent_name, text.slice(0, 4000), row.created_at);
    }
  }
}

/** Rebuild the task FTS index from task_results, artifacts, evidence, and verdicts. */
export function rebuildTaskFts(conversationId: string): void {
  const db = getDatabase();

  db.prepare("DELETE FROM context_fts_tasks WHERE conversation_id = ?").run(conversationId);

  const insert = db.prepare(`
    INSERT INTO context_fts_tasks (source_type, source_id, conversation_id, task_id, text_content, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  // Index verified task summaries
  const tasks = db
    .prepare(`
      SELECT task_id, summary, created_at FROM conductor_task_results
      WHERE conversation_id = ? AND status = 'complete'
    `)
    .all(conversationId) as Array<{ task_id: string; summary: string; created_at: number }>;
  for (const t of tasks) {
    insert.run("task_result", t.task_id, conversationId, t.task_id, t.summary.slice(0, 2000), t.created_at);
  }

  // Index artifact titles
  const arts = db
    .prepare(`
      SELECT id, title, type, created_at FROM artifacts
      WHERE conversation_id = ?
    `)
    .all(conversationId) as Array<{ id: string; title: string; type: string; created_at: number }>;
  for (const a of arts) {
    insert.run("artifact", a.id, conversationId, "", `${a.title} ${a.type}`, a.created_at);
  }

  // Index evidence subjects
  const ev = db
    .prepare(`
      SELECT id, type, subject_id, subject_type, task_id, created_at FROM task_evidence
      WHERE conversation_id = ? AND status = 'valid'
    `)
    .all(conversationId) as Array<{
      id: string; type: string; subject_id: string; subject_type: string;
      task_id: string; created_at: number;
    }>;
  for (const e of ev) {
    insert.run("evidence", e.id, conversationId, e.task_id, `${e.type} ${e.subject_id} ${e.subject_type}`, e.created_at);
  }

  // Index verdict reasons
  const verdicts = db
    .prepare(`
      SELECT cv.id, cv.criterion_id, cv.reason, cv.status, ta.task_id, cv.checked_at
      FROM criterion_verdicts cv
      JOIN task_attempts ta ON cv.attempt_id = ta.id
      WHERE ta.conversation_id = ?
    `)
    .all(conversationId) as Array<{
      id: string; criterion_id: string; reason: string; status: string; task_id: string; checked_at: number;
    }>;
  for (const v of verdicts) {
    insert.run("verdict", v.id, conversationId, v.task_id, `${v.criterion_id} ${v.status} ${v.reason}`, v.checked_at);
  }
}

/** Convenience: rebuild all FTS indexes for a conversation. */
export function rebuildAllFts(conversationId: string): void {
  rebuildMessageFts(conversationId);
  rebuildTaskFts(conversationId);
}
