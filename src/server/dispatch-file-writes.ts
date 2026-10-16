import { createHash } from "node:crypto";

// ---------------------------------------------------------------------------
// Per-run file write tracking — used by cs_write tool and Conductor conflict detection
// ---------------------------------------------------------------------------

declare global {
  var __agentMeldFileWrites: Map<string, Map<string, string>> | undefined;
  var __agentMeldFileWriteOrders: { next: number; runs: Map<string, Map<string, number>> } | undefined;
}

function getOrders() {
  return globalThis.__agentMeldFileWriteOrders ??= { next: 0, runs: new Map() };
}

function getStore(): Map<string, Map<string, string>> {
  if (!globalThis.__agentMeldFileWrites) {
    globalThis.__agentMeldFileWrites = new Map();
  }
  return globalThis.__agentMeldFileWrites;
}

export function recordFileWrite(runId: string, absolutePath: string, content: string): void {
  const store = getStore();
  let files = store.get(runId);
  if (!files) {
    files = new Map();
    store.set(runId, files);
  }
  files.set(absolutePath, createHash("sha1").update(content).digest("hex"));
  const orders = getOrders();
  const run = orders.runs.get(runId) ?? new Map<string, number>();
  run.set(absolutePath, ++orders.next);
  orders.runs.set(runId, run);
}

export function getFileWrites(runId: string): Map<string, string> {
  return getStore().get(runId) ?? new Map();
}

export function clearFileWrites(runId: string): void {
  getStore().delete(runId);
  getOrders().runs.delete(runId);
}

export function getFileWriteOrder(runId: string): Map<string, number> { return getOrders().runs.get(runId) ?? new Map(); }

// ---------------------------------------------------------------------------
// Conflict detection — same wave, same file, different content = conflict
// ---------------------------------------------------------------------------

export interface RunFileWrites {
  taskId: string;
  agentId: string;
  runId: string;
  writes: Map<string, string>; // absPath → sha1
  writeOrder?: Map<string, number>;
}

export interface FileWriteConflict {
  path: string;
  contributors: Array<{ taskId: string; agentId: string; runId: string }>;
}

/** Attempts are ordered oldest-first. Preserve the last real writer of each
 * file within a logical task, including files untouched by its final attempt. */
export function collapseTaskAttemptWrites(attempts: RunFileWrites[]): RunFileWrites[] {
  const owners = new Map<string, Map<string, { owner: RunFileWrites; hash: string }>>();
  for (const attempt of attempts) {
    const files = owners.get(attempt.taskId) ?? new Map();
    for (const [file, hash] of attempt.writes) {
      const previous = files.get(file);
      if (previous && (previous.owner.writeOrder?.get(file) ?? 0) > (attempt.writeOrder?.get(file) ?? 0)) continue;
      files.set(file, { owner: attempt, hash });
    }
    owners.set(attempt.taskId, files);
  }
  const grouped = new Map<string, RunFileWrites>();
  for (const files of owners.values()) for (const [file, { owner, hash }] of files) {
    const key = JSON.stringify([owner.taskId, owner.runId]);
    const group = grouped.get(key) ?? { taskId: owner.taskId, agentId: owner.agentId, runId: owner.runId, writes: new Map() };
    group.writes.set(file, hash); grouped.set(key, group);
  }
  return [...grouped.values()];
}

export function detectWaveConflicts(runs: RunFileWrites[]): FileWriteConflict[] {
  const byPath = new Map<string, Array<{ taskId: string; agentId: string; runId: string; hash: string }>>();

  for (const run of runs) {
    for (const [absPath, hash] of run.writes) {
      const list = byPath.get(absPath) ?? [];
      list.push({ taskId: run.taskId, agentId: run.agentId, runId: run.runId, hash });
      byPath.set(absPath, list);
    }
  }

  const conflicts: FileWriteConflict[] = [];
  for (const [absPath, writers] of byPath) {
    if (writers.length < 2) continue;
    // Same content hash = not a conflict
    const hashes = new Set(writers.map((w) => w.hash));
    if (hashes.size < 2) continue;

    conflicts.push({
      path: absPath,
      contributors: writers.map((w) => ({ taskId: w.taskId, agentId: w.agentId, runId: w.runId }))
    });
  }

  return conflicts;
}

export function clearAllFileWritesForTests(): void {
  getStore().clear();
  getOrders().runs.clear();
  getOrders().next = 0;
}
