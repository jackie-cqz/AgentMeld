import { markRunInterrupted, listOrphanedRunningRuns } from "@/server/repositories";
import { cancelPendingPlansForRun } from "@/server/dispatch-plan-manager";
import { cancelPendingQuestionsForRun } from "@/server/pending-questions";
import { clearFileWrites } from "@/server/dispatch-file-writes";
import { clearTaskResultsForRun } from "@/server/dispatch-task-results";

/**
 * P1: Run lifecycle recovery — called at startup.
 *
 * Strategy (per BACKEND_REMAINING_PRIORITY_PLAN.md §P1):
 * - Don't resume mid-LLM-stream. Mark orphaned `running` runs as `interrupted`/`failed`.
 * - Clean up associated in-memory pending items and file write records.
 * - Users can re-execute from the original message or Orchestrator can re-plan.
 */
export function recoverOrphanedRuns() {
  const orphaned = listOrphanedRunningRuns();
  if (orphaned.length === 0) return;

  const now = Date.now();
  for (const run of orphaned) {
    // Mark the run as interrupted in DB
    markRunInterrupted(run.id, now);

    // Clear in-memory pending items
    cancelPendingPlansForRun(run.id);
    cancelPendingQuestionsForRun(run.id);
    clearFileWrites(run.id);
    clearTaskResultsForRun(run.id);

    // If this is an orchestrator run, also clean up child runs
    if (run.agentId) {
      // Child runs will be found as orphaned too (they have status='running')
      // Their parent_run_id will point to this orchestrator run
    }
  }

  console.log(`[run-recovery] Marked ${orphaned.length} orphaned runs as interrupted.`);
}
