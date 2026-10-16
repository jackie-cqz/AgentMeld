import { randomUUID } from "node:crypto";
import { getDatabase } from "@/db/client";
import { eventBus } from "@/server/event-bus";
import type { AgentRun, Message } from "@/shared/types";
import type { CollaborationTurn } from "@/shared/collaboration-types";

type Row = Record<string, unknown>;
function map(row: Row): CollaborationTurn {
  return {
    id: row.id as string, conversationId: row.conversation_id as string, messageId: row.message_id as string,
    agentId: row.agent_id as string, runId: row.run_id as string, targetRunId: row.target_run_id as string | null,
    topicMessageId: row.topic_message_id as string, intent: row.intent as CollaborationTurn["intent"], mode: row.mode as CollaborationTurn["mode"],
    status: row.status as CollaborationTurn["status"], contextSnapshotId: row.context_snapshot_id as string | null,
    context: row.context_json as string | null, reason: row.reason as string | null,
    resolvedBy: row.resolved_by as string | null, resolutionMessageId: row.resolution_message_id as string | null, resolvedAt: row.resolved_at as number | null,
    createdAt: row.created_at as number, updatedAt: row.updated_at as number,
  };
}
export function getCollaborationTurn(id: string): CollaborationTurn | null {
  const row = getDatabase().prepare("SELECT * FROM collaboration_turns WHERE id=?").get(id) as Row | undefined;
  return row ? map(row) : null;
}
export function listCollaborationTurns(conversationId: string): CollaborationTurn[] {
  return (getDatabase().prepare("SELECT * FROM collaboration_turns WHERE conversation_id=? ORDER BY created_at,id").all(conversationId) as Row[]).map(map);
}
export function createCollaborationTurn(run: AgentRun, message: Message): CollaborationTurn {
  if (message.origin !== "human" || message.role !== "user" || message.conversationId !== run.conversationId || run.parentRunId) {
    throw new Error("Only a human root turn can acquire conversational admission.");
  }
  const id = `turn_${randomUUID()}`;
  const now = Date.now();
  getDatabase().prepare(`INSERT INTO collaboration_turns
    (id,conversation_id,message_id,agent_id,run_id,topic_message_id,status,created_at,updated_at)
    VALUES (?,?,?,?,?,?,'received',?,?)`).run(id, run.conversationId, message.id, run.agentId, run.id, message.parentMessageId ?? message.id, now, now);
  return publish(getCollaborationTurn(id)!);
}

/** Applicability snapshots are immutable once captured; delivery state is monotonic. */
export function updateCollaborationTurn(id: string, patch: Partial<Pick<CollaborationTurn, "intent" | "mode" | "status" | "targetRunId" | "reason" | "resolvedBy" | "resolutionMessageId" | "resolvedAt">> & { context?: string }): CollaborationTurn {
  const current = getCollaborationTurn(id);
  if (!current) throw new Error("Collaboration turn not found.");
  const terminal = ["applied", "rejected", "cancelled", "resolved"];
  if (terminal.includes(current.status) && patch.context === undefined) return current;
  const next = terminal.includes(current.status) ? current : { ...current, ...patch };
  const context = patch.context ?? current.context;
  const newSnapshot = context !== null && context !== current.context;
  const snapshotId = newSnapshot ? `turn_ctx_${randomUUID()}` : current.contextSnapshotId;
  const now = Math.max(Date.now(), current.updatedAt + 1);
  if (newSnapshot) getDatabase().prepare("INSERT INTO collaboration_context_snapshots (id,turn_id,previous_snapshot_id,context_json,created_at) VALUES (?,?,?,?,?)")
    .run(snapshotId, id, current.contextSnapshotId, context, now);
  getDatabase().prepare(`UPDATE collaboration_turns SET intent=?,mode=?,status=?,target_run_id=?,reason=?,context_snapshot_id=?,context_json=?,resolved_by=?,resolution_message_id=?,resolved_at=?,updated_at=? WHERE id=?`)
    .run(next.intent, next.mode, next.status, next.targetRunId, next.reason, snapshotId, context, next.resolvedBy, next.resolutionMessageId, next.resolvedAt, now, id);
  return publish(getCollaborationTurn(id)!);
}

function publish(turn: CollaborationTurn): CollaborationTurn {
  // Context is persisted for traceability, not echoed into every browser event.
  eventBus.publish({ type: "collaboration.turn", conversationId: turn.conversationId, timestamp: turn.updatedAt, turn: { ...turn, context: null } });
  return turn;
}
