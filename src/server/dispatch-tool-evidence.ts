// ---------------------------------------------------------------------------
// P1: Tool evidence — SQLite-backed with in-memory fallback for non-task runs
//
// recordFileWriteEvidence / recordCommandEvidence are kept as a short-term
// compatibility facade. They write to in-memory store for non-task runs,
// while task runs are captured through the Evidence Collector in SQLite.
//
// getRunToolEvidence now queries SQLite for task runs and falls back to the
// in-memory store for non-task runs.
//
// clearRunToolEvidence clears only the in-memory cache; the SQLite Ledger is
// immutable — evidence is never deleted.
// ---------------------------------------------------------------------------

import { listEvidenceForChildRun } from "@/server/repositories/evidence-repository";

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
  const current = getOrCreate(runId);
  const index = current.fileWrites.findIndex((entry) => entry.path === evidence.path);
  if (index >= 0) {
    current.fileWrites[index] = evidence;
  } else {
    current.fileWrites.push(evidence);
  }
}

export function recordCommandEvidence(
  runId: string,
  evidence: CommandEvidence
): void {
  if (!runId) return;
  getOrCreate(runId).commands.push(evidence);
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
