import { markRunInterrupted, listOrphanedRunningRuns, interruptAllPendingApprovals, cancelApprovalsForRun } from "@/server/repositories";
import { retireNonTerminalAttempts } from "@/server/repositories/evidence-repository";
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
 *
 * PRECONDITION: this assumes nothing is in flight — it force-fails EVERY run still
 * marked 'running'. That holds when it is reached from `ensureDatabase`, whose first
 * call in a process necessarily precedes any run, but it does NOT hold for an arbitrary
 * later call: a second process sharing the data directory (or a mid-session
 * re-bootstrap) would kill live runs and retire their attempts. Anything calling this
 * outside process start has to revisit that assumption first.
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
  if (orphaned.length > 0) {
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

  // Runs are repaired above; the attempt rows they own need repairing too, and this
  // must NOT be skipped when there are no orphaned runs. An attempt is finished by the
  // run that owns it, so once that run is no longer running the row can never be
  // finished by anything — whether the run was interrupted just now, or ended earlier
  // and leaked the row. Rows leaked by an older build have exactly that shape: their
  // parent run completed normally, so scanning only orphaned runs would never see them.
  //
  // Note that by this point the sweep's own `status <> 'running'` filter matches every
  // row, because the loop above just force-failed every running run. The filter is not
  // what keeps this safe; the process-start precondition on this function is.
  const retired = retireNonTerminalAttempts(now);
  if (retired > 0) {
    console.log(`[run-recovery] Retired ${retired} attempt(s) left non-terminal by a stopped run.`);
  }
}
