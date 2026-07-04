// ---------------------------------------------------------------------------
// P3: Failure Context builder
// ---------------------------------------------------------------------------

import type { FailureContext } from "@/shared/task-context-types";
import type { CriterionVerdict } from "@/shared/evidence-types";

// Re-export for context-compiler
export type { FailureContext };
import { listEvidenceForAttempt } from "@/server/repositories/evidence-repository";

export interface FailureContextInput {
  previousAttemptId: string;
  previousChildRunId: string;
  failedCriteria: CriterionVerdict[];
  previousError?: string;
}

export async function buildFailureContext(input: FailureContextInput): Promise<FailureContext> {
  const failedEvidenceIds: string[] = [];
  const failedCommands: FailureContext["failedCommands"] = [];
  const missingOutputs: string[] = [];
  const changedFiles: FailureContext["changedFiles"] = [];

  // Collect evidence from the failed attempt
  try {
    const evidence = listEvidenceForAttempt(input.previousAttemptId);
    for (const ev of evidence) {
      if (ev.status === "invalid" || ev.status === "diagnostic") {
        failedEvidenceIds.push(ev.id);
      }
      if ((ev.type === "command_executed" || ev.type === "test_executed") && ev.status === "invalid") {
        try {
          const p = JSON.parse(ev.payloadJson);
          failedCommands.push({
            command: (p.command as string) ?? ev.subjectId,
            exitCode: (p.exitCode as number | null) ?? null,
            errorExcerpt: (p.outputExcerpt as string)?.slice(0, 500) ?? "no output",
            evidenceId: ev.id,
          });
        } catch {
          failedCommands.push({ command: ev.subjectId, exitCode: null, errorExcerpt: "parse error", evidenceId: ev.id });
        }
      }
      if (ev.type === "file_written") {
        changedFiles.push({ path: ev.subjectId, contentHash: ev.contentHash, evidenceId: ev.id });
      }
    }
  } catch { /* best-effort */ }

  // Collect failed criterion details
  for (const c of input.failedCriteria) {
    failedEvidenceIds.push(...c.evidenceIds);
  }

  // Build retry instructions
  const retryInstructions: string[] = [];
  for (const c of input.failedCriteria) {
    retryInstructions.push(`Failed criterion "${c.criterionId}" (${c.status}): ${c.reason}`);
  }
  for (const cmd of failedCommands) {
    retryInstructions.push(`Command "${cmd.command}" exited with ${cmd.exitCode}: ${cmd.errorExcerpt}`);
  }
  if (input.previousError) {
    retryInstructions.push(`Previous attempt error: ${input.previousError}`);
  }

  return {
    previousAttemptId: input.previousAttemptId,
    previousChildRunId: input.previousChildRunId,
    failedCriteria: input.failedCriteria,
    failedEvidenceIds,
    failedCommands,
    missingOutputs,
    changedFiles,
    retryInstructions: retryInstructions.length > 0 ? retryInstructions : ["Unknown failure — retry with same context."],
  };
}
