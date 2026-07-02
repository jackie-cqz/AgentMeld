// ---------------------------------------------------------------------------
// P1: Tool evidence — SQLite-backed with in-memory fallback
//
// recordFileWriteEvidence / recordCommandEvidence are compatibility facades
// that write to BOTH in-memory AND SQLite (via evidenceRepository).
//
// getRunToolEvidence queries SQLite first, falls back to in-memory.
// clearRunToolEvidence clears only in-memory; the SQLite Ledger is immutable.
// ---------------------------------------------------------------------------

import { listEvidenceForChildRun, insertEvidence } from "@/server/repositories/evidence-repository";
import { newEvidenceId } from "@/shared/ids";

export interface FileWriteEvidence {
  path: string;
  absolutePath: string;
  action: "created" | "modified";
}

export interface CommandEvidence {
  command: string;
  exitCode: number | null;
  cwd?: string;
  timedOut: boolean;
  isError: boolean;
}

export interface RunToolEvidence {
  fileWrites: FileWriteEvidence[];
  commands: CommandEvidence[];
}

declare global {
  var __agentMeldToolEvidence: Map<string, RunToolEvidence> | undefined;
}

function getStore(): Map<string, RunToolEvidence> {
  if (!globalThis.__agentMeldToolEvidence) {
    globalThis.__agentMeldToolEvidence = new Map();
  }
  return globalThis.__agentMeldToolEvidence;
}

function getOrCreate(runId: string): RunToolEvidence {
  const store = getStore();
  const existing = store.get(runId);
  if (existing) return existing;
  const evidence: RunToolEvidence = { fileWrites: [], commands: [] };
  store.set(runId, evidence);
  return evidence;
}

export function recordFileWriteEvidence(
  runId: string,
  evidence: FileWriteEvidence
): void {
  if (!runId) return;
  // In-memory store (immediate access for evaluation)
  const current = getOrCreate(runId);
  const index = current.fileWrites.findIndex((entry) => entry.path === evidence.path);
  if (index >= 0) {
    current.fileWrites[index] = evidence;
  } else {
    current.fileWrites.push(evidence);
  }

  // P1: Also persist to SQLite Evidence Ledger with available identity
  tryPersistToLedger(runId, "file_written", "file", evidence.path || evidence.absolutePath, {
    path: evidence.path,
    absolutePath: evidence.absolutePath,
    action: evidence.action,
  });
}

export function recordCommandEvidence(
  runId: string,
  evidence: CommandEvidence
): void {
  if (!runId) return;
  // In-memory store (immediate access for evaluation)
  getOrCreate(runId).commands.push(evidence);

  // P1: Also persist to SQLite Evidence Ledger
  tryPersistToLedger(runId, "command_executed", "command", evidence.command.slice(0, 120), {
    command: evidence.command.slice(0, 500),
    exitCode: evidence.exitCode,
    timedOut: evidence.timedOut,
    isError: evidence.isError,
    cwd: evidence.cwd ?? null,
  });
}

/**
 * P1: Attempt to persist evidence to the SQLite Ledger.
 * Falls back silently if task identity is unavailable (non-task runs).
 */
function tryPersistToLedger(
  childRunId: string,
  type: string,
  subjectType: string,
  subjectId: string,
  payload: Record<string, unknown>
) {
  try {
    // Try to get task identity from existing evidence or task_attempts
    const { getDatabase } = require("@/db/client") as { getDatabase: () => unknown };
    const db = getDatabase() as { prepare: (sql: string) => { get: (...args: unknown[]) => { attempt_id?: string; conductor_run_id?: string; plan_id?: string; task_id?: string; context_snapshot_id?: string; agent_id?: string; conversation_id?: string } | undefined } };
    const row = db
      .prepare("SELECT attempt_id FROM task_attempts WHERE child_run_id = ? LIMIT 1")
      .get(childRunId);

    if (row?.attempt_id) {
      const attempt = db
        .prepare("SELECT * FROM task_attempts WHERE id = ?")
        .get(row.attempt_id) as { conversation_id?: string; conductor_run_id?: string; plan_id?: string; task_id?: string; context_snapshot_id?: string; agent_id?: string } | undefined;

      if (attempt) {
        insertEvidence({
          id: newEvidenceId(),
          conversationId: attempt.conversation_id ?? "",
          conductorRunId: attempt.conductor_run_id ?? "",
          planId: attempt.plan_id ?? "",
          taskId: attempt.task_id ?? "",
          attemptId: row.attempt_id,
          childRunId,
          contextSnapshotId: attempt.context_snapshot_id ?? "",
          agentId: attempt.agent_id ?? "",
          type,
          status: "valid",
          trustLevel: "verified",
          sourceKind: "tool_call",
          sourceId: `${type}_${Date.now()}`,
          subjectType,
          subjectId,
          payloadJson: JSON.stringify(payload),
          contentHash: null,
          invalidatedAt: null,
          createdAt: Date.now(),
        });
      }
    }
  } catch {
    // Non-task run or DB not available — evidence stays in-memory only
  }
}

export function getRunToolEvidence(runId: string): RunToolEvidence {
  // P1: Try SQLite first — query evidence ledger for this child run
  try {
    const records = listEvidenceForChildRun(runId);
    if (records.length > 0) {
      const fileWrites: FileWriteEvidence[] = [];
      const commands: CommandEvidence[] = [];

      for (const rec of records) {
        const payload = safeJsonParse(rec.payloadJson);
        if (rec.type === "file_written" && payload) {
          fileWrites.push({
            path: (payload.path as string) ?? rec.subjectId,
            absolutePath: ((payload.absolutePath ?? payload.path) as string) ?? rec.subjectId,
            action: (payload.action as "created" | "modified") ?? "modified",
          });
        } else if (rec.type === "command_executed" || rec.type === "test_executed") {
          commands.push({
            command: ((payload?.command as string) ?? rec.subjectId) || "",
            exitCode: (payload?.exitCode as number | null) ?? null,
            timedOut: (payload?.timedOut as boolean) ?? false,
            isError: (payload?.exitCode as number) !== 0,
          });
        }
      }

      // Merge with in-memory for immediate evidence not yet persisted
      const mem = getStore().get(runId);
      if (mem) {
        return {
          fileWrites: mergeByPath(fileWrites, mem.fileWrites),
          commands: [...commands, ...mem.commands],
        };
      }
      return { fileWrites, commands };
    }
  } catch {
    // SQLite not available (e.g. tests) — fall through to in-memory
  }

  // Fallback: in-memory store
  const evidence = getStore().get(runId);
  return evidence
    ? {
        fileWrites: evidence.fileWrites.map((entry) => ({ ...entry })),
        commands: evidence.commands.map((entry) => ({ ...entry })),
      }
    : { fileWrites: [], commands: [] };
}

/** P1: Clear only in-memory cache. SQLite Ledger is never cleared. */
export function clearRunToolEvidence(runId: string): void {
  getStore().delete(runId);
}

export function clearAllToolEvidenceForTests(): void {
  getStore().clear();
}

// ── Helpers ───────────────────────────────────────────────────────────────

function safeJsonParse(json: string): Record<string, unknown> | null {
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}

function mergeByPath(
  existing: FileWriteEvidence[],
  incoming: FileWriteEvidence[]
): FileWriteEvidence[] {
  const map = new Map<string, FileWriteEvidence>();
  for (const e of existing) map.set(e.path, e);
  for (const e of incoming) map.set(e.path, e);
  return Array.from(map.values());
}
