// ---------------------------------------------------------------------------
// P1: Tool evidence — SQLite-backed with in-memory fallback
//
// recordFileWriteEvidence / recordCommandEvidence are compatibility facades
// for the immediate in-memory verification view. SQLite persistence is owned
// exclusively by ToolRegistry -> captureEvidence so one tool call has one
// canonical ledger path.
//
// getRunToolEvidence queries SQLite first, falls back to in-memory.
// clearRunToolEvidence clears only in-memory; the SQLite Ledger is immutable.
// ---------------------------------------------------------------------------

import {
  listEvidenceForChildRun,
  listEvidenceForTask,
  type EvidenceRecord,
} from "@/server/repositories/evidence-repository";

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
  observedPaths: string[];
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
  const evidence: RunToolEvidence = { fileWrites: [], observedPaths: [], commands: [] };
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

}

export function recordCommandEvidence(
  runId: string,
  evidence: CommandEvidence
): void {
  if (!runId) return;
  // In-memory store (immediate access for evaluation)
  getOrCreate(runId).commands.push(evidence);

}

export function getRunToolEvidence(runId: string): RunToolEvidence {
  // P1: Try SQLite first — query evidence ledger for this child run
  try {
    const records = listEvidenceForChildRun(runId);
    if (records.length > 0) {
      const { fileWrites, observedPaths, commands } = evidenceRecordsToToolEvidence(records);

      // Merge with in-memory for immediate evidence not yet persisted
      const mem = getStore().get(runId);
      if (mem) {
        return {
          fileWrites: mergeByPath(fileWrites, mem.fileWrites),
          observedPaths: mergePaths(observedPaths, mem.observedPaths),
          commands: mergeCommands(commands, mem.commands),
        };
      }
      return { fileWrites, observedPaths, commands };
    }
  } catch {
    // SQLite not available (e.g. tests) — fall through to in-memory
  }

  // Fallback: in-memory store
  const evidence = getStore().get(runId);
  return evidence
    ? {
        fileWrites: evidence.fileWrites.map((entry) => ({ ...entry })),
        observedPaths: [...evidence.observedPaths],
        commands: evidence.commands.map((entry) => ({ ...entry })),
      }
    : { fileWrites: [], observedPaths: [], commands: [] };
}

/**
 * Returns the cumulative evidence chain for a logical task execution.
 *
 * Retries and recovery tasks share one workspace. A recovery attempt may only
 * need to inspect existing source, rerun verification, create the artifact,
 * and deploy it. Requiring that attempt to rewrite every target path would
 * discard valid evidence from the original attempt and encourage destructive
 * no-op rewrites.
 */
export function getTaskToolEvidence(input: {
  conductorRunId: string;
  planId: string;
  taskIds: string[];
  currentRunId?: string;
}): RunToolEvidence {
  const uniqueTaskIds = [...new Set(input.taskIds.filter(Boolean))];
  const records = uniqueTaskIds.flatMap((taskId) =>
    listEvidenceForTask(input.conductorRunId, input.planId, taskId)
  );
  const ledgerEvidence = evidenceRecordsToToolEvidence(
    records.sort((left, right) => left.createdAt - right.createdAt)
  );
  const currentEvidence = input.currentRunId
    ? getStore().get(input.currentRunId)
    : undefined;

  if (!currentEvidence) return ledgerEvidence;
  return {
    fileWrites: mergeByPath(ledgerEvidence.fileWrites, currentEvidence.fileWrites),
    observedPaths: mergePaths(ledgerEvidence.observedPaths, currentEvidence.observedPaths),
    commands: mergeCommands(ledgerEvidence.commands, currentEvidence.commands),
  };
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

function evidenceRecordsToToolEvidence(records: EvidenceRecord[]): RunToolEvidence {
  const fileWrites: FileWriteEvidence[] = [];
  const observedPaths: string[] = [];
  const commands: CommandEvidence[] = [];

  for (const record of records) {
    if (record.invalidatedAt !== null || record.status !== "valid") continue;
    const payload = safeJsonParse(record.payloadJson);
    if (record.type === "file_written" && payload) {
      fileWrites.push({
        path: (payload.path as string) ?? record.subjectId,
        absolutePath: ((payload.absolutePath ?? payload.path) as string) ?? record.subjectId,
        action: (payload.action as "created" | "modified") ?? "modified",
      });
    } else if (record.type === "file_read") {
      observedPaths.push(
        (payload?.path as string | undefined) ?? record.subjectId
      );
    } else if (record.type === "command_executed" || record.type === "test_executed") {
      const exitCode = (payload?.exitCode as number | null) ?? null;
      commands.push({
        command: ((payload?.command as string) ?? record.subjectId) || "",
        exitCode,
        timedOut: (payload?.timedOut as boolean) ?? false,
        isError: (payload?.isError as boolean | undefined) ?? exitCode !== 0,
      });
    }
  }

  return {
    fileWrites: mergeByPath([], fileWrites),
    observedPaths: mergePaths([], observedPaths),
    commands,
  };
}

function mergePaths(existing: string[], incoming: string[]): string[] {
  return [...new Set([...existing, ...incoming].filter(Boolean))];
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

function mergeCommands(
  existing: CommandEvidence[],
  incoming: CommandEvidence[],
): CommandEvidence[] {
  const map = new Map<string, CommandEvidence>();
  for (const command of [...existing, ...incoming]) {
    const key = [
      command.command,
      command.cwd ?? "",
      String(command.exitCode),
      String(command.timedOut),
      String(command.isError),
    ].join("\u0000");
    map.set(key, command);
  }
  return [...map.values()];
}
