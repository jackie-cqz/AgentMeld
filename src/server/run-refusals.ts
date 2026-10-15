/**
 * Why a run was refused before it existed.
 *
 * The delegation gate is the only refusal of that shape: it happens before any
 * run row is written, so the caller cannot learn the reason from the database,
 * and it must not be inferred from an absent row (a mocked or a future runner
 * would look identical). The runner records the reason here and the conductor
 * reads it back — an explicit hand-off rather than a guess.
 *
 * This lives in its own module rather than in agent-runner so tests can import
 * it without touching the runner's mock surface.
 */

const refusals = new Map<string, string>();

export function recordRunRefusal(runId: string, reason: string): void {
  refusals.set(runId, reason);
}

/** Read and clear: a caller asks once per run. */
export function takeRunRefusalReason(runId: string): string | null {
  const reason = refusals.get(runId) ?? null;
  refusals.delete(runId);
  return reason;
}

export function clearRunRefusalsForTests(): void {
  refusals.clear();
}
