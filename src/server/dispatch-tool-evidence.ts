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
  const evidence = getStore().get(runId);
  return evidence
    ? {
        fileWrites: evidence.fileWrites.map((entry) => ({ ...entry })),
        commands: evidence.commands.map((entry) => ({ ...entry }))
      }
    : { fileWrites: [], commands: [] };
}

export function clearRunToolEvidence(runId: string): void {
  getStore().delete(runId);
}

export function clearAllToolEvidenceForTests(): void {
  getStore().clear();
}
