import { markRunInterrupted, listOrphanedRunningRuns, interruptAllPendingApprovals, cancelApprovalsForRun } from "@/server/repositories";
import { recoverCompactionJobs } from "@/server/context-compaction-service";
import { cancelPendingPlansForRun } from "@/server/dispatch-plan-manager";
import { cancelPendingQuestionsForRun } from "@/server/pending-questions";
import { clearFileWrites } from "@/server/dispatch-file-writes";
import { clearTaskResultsForRun } from "@/server/dispatch-task-results";
import { clearRunToolEvidence } from "@/server/dispatch-tool-evidence";

/**
 * P1+P2: Run lifecycle + approval recovery — called at startup.
 *
 * Strategy (per BACKEND_REMAINING_PRIORITY_PLAN.md §P1, §P2):
 * - Don't resume mid-LLM-stream. Mark orphaned runs as interrupted/failed.
 * - Mark orphaned pending approvals as interrupted.
 * - Clean up in-memory pending items and file write records.
 */
export function recoverOrphanedRuns() {
  const now = Date.now();

  // P2: First, mark all pending approvals in DB as interrupted
  interruptAllPendingApprovals(now);

  // P1: Recover orphaned compaction jobs
  const recoveredJobs = recoverCompactionJobs(now);
  if (recoveredJobs > 0) {
    console.log(`[run-recovery] Marked ${recoveredJobs} orphaned compaction jobs as interrupted.`);
  }

  const orphaned = listOrphanedRunningRuns();
  if (orphaned.length === 0) return;

  for (const run of orphaned) {
    markRunInterrupted(run.id, now);

    // Clear in-memory pending items + DB approvals for this run
    cancelApprovalsForRun(run.id, now);
    cancelPendingPlansForRun(run.id);
    cancelPendingQuestionsForRun(run.id);
    clearFileWrites(run.id);
    clearTaskResultsForRun(run.id);
    clearRunToolEvidence(run.id);
  }

  console.log(`[run-recovery] Marked ${orphaned.length} orphaned runs as interrupted.`);
}
