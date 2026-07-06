// ---------------------------------------------------------------------------
// P3: Context Quality Metrics Service — raw metrics + derived rates
// ---------------------------------------------------------------------------

import { getDatabase } from "@/db/client";
import type {
  ContextQualityRunMetrics,
  ContextQualityDerivedRates,
  ContextQualityReport,
} from "@/server/context-metrics/context-metrics-types";

// ── Public ──────────────────────────────────────────────────────────────────

/** Compute the full quality report for a conductor run */
export function computeRunMetrics(runId: string): ContextQualityReport | { error: string; status: number } {
  const raw = collectRawMetrics(runId);
  if (!raw) return { error: "No task attempts found for this run.", status: 404 };

  const derived = computeDerivedRates(raw);
  return { runId, raw, derived };
}

// ── Raw metrics collection ──────────────────────────────────────────────────

function collectRawMetrics(conductorRunId: string): ContextQualityRunMetrics | null {
  const db = getDatabase();

  const attempts = db
    .prepare("SELECT id, task_id, execution_status, verification_status, child_run_id, context_snapshot_id FROM task_attempts WHERE conductor_run_id = ? AND task_id != 'conductor'")
    .all(conductorRunId) as Array<{
      id: string; task_id: string; execution_status: string; verification_status: string;
      child_run_id: string | null; context_snapshot_id: string | null;
    }>;

  if (attempts.length === 0) return null;

  const taskIds = new Set(attempts.map((a) => a.task_id));
  const taskCount = taskIds.size;
  const attemptCount = attempts.length;
  const completedTaskCount = attempts.filter((a) => a.execution_status === "reported_complete").length;
  const failedTaskCount = attempts.filter((a) => a.execution_status === "failed").length;

  // Input metrics: for each attempt, check upstream inputs via bindings
  let verifiedInputCount = 0;
  let missingRequiredInputCount = 0;
  let upstreamInputReadCount = 0;
  let upstreamInputUnreadCount = 0;

  // Evidence metrics
  let evidenceCount = 0;
  let artifactCreatedCount = 0;
  let deploymentReadyCount = 0;

  for (const att of attempts) {
    const evRows = db
      .prepare("SELECT type, status, payload_json FROM task_evidence WHERE attempt_id = ?")
      .all(att.id) as Array<{ type: string; status: string; payload_json: string }>;
    evidenceCount += evRows.length;
    artifactCreatedCount += evRows.filter((e) => e.type === "artifact_created").length;
    deploymentReadyCount += evRows.filter((e) => e.type === "deployment_created" && e.status === "valid").length;

    // Check upstream reads
    for (const ev of evRows) {
      if (ev.type === "artifact_read") {
        upstreamInputReadCount++;
      }
    }
  }

  // Check bindings
  const allBindings = db
    .prepare("SELECT * FROM conductor_output_bindings WHERE conductor_run_id = ?")
    .all(conductorRunId) as Array<{ producer_task_id: string; output_key: string }>;
  const verifiedOutputBindingCount = allBindings.length;

  // Check plan for input declarations
  const planRow = db
    .prepare("SELECT plan_json FROM conductor_plans WHERE conductor_run_id = ? ORDER BY revision DESC LIMIT 1")
    .get(conductorRunId) as { plan_json: string } | undefined;

  if (planRow) {
    try {
      const tasks = JSON.parse(planRow.plan_json) as Array<{
        id: string; dependsOn?: string[]; inputs?: Array<{ fromTaskId: string; outputId: string; required?: boolean }>;
      }>;

      for (const task of tasks) {
        // Gather all expected inputs (explicit + dependsOn-derived)
        const specs = new Map<string, { fromTaskId: string; outputId: string }>();
        for (const input of task.inputs ?? []) {
          specs.set(`${input.fromTaskId}.${input.outputId}`, { fromTaskId: input.fromTaskId, outputId: input.outputId });
        }
        for (const dep of task.dependsOn ?? []) {
          for (const b of allBindings) {
            if (b.producer_task_id === dep && !specs.has(`${b.producer_task_id}.${b.output_key}`)) {
              specs.set(`${b.producer_task_id}.${b.output_key}`, { fromTaskId: b.producer_task_id, outputId: b.output_key });
            }
          }
        }

        for (const [, spec] of specs) {
          const found = allBindings.some((b) => b.producer_task_id === spec.fromTaskId && b.output_key === spec.outputId);
          if (found) verifiedInputCount++;
          else missingRequiredInputCount++;
        }
      }
    } catch { /* ok */ }
  }

  // Tool call count from agent_runs with tool events
  let toolCallCount = 0;
  let failedToolCallCount = 0;
  for (const att of attempts) {
    if (att.child_run_id) {
      try {
        const toolRows = db
          .prepare("SELECT COUNT(*) AS cnt FROM task_evidence WHERE child_run_id = ?")
          .get(att.child_run_id) as { cnt: number };
        toolCallCount += toolRows.cnt;
        const failedRows = db
          .prepare("SELECT COUNT(*) AS cnt FROM task_evidence WHERE child_run_id = ? AND status != 'valid'")
          .get(att.child_run_id) as { cnt: number };
        failedToolCallCount += failedRows.cnt;
      } catch { /* ok */ }
    }
  }

  // Context manifest stats from snapshots
  let contextIncludedItemCount = 0;
  let contextOmittedItemCount = 0;
  let contextOmittedByBudgetCount = 0;
  let staleRejectedCount = 0;
  let unverifiedRejectedCount = 0;
  let unrelatedRejectedCount = 0;

  for (const att of attempts) {
    if (!att.context_snapshot_id) continue;
    const snap = db
      .prepare("SELECT manifest_json FROM task_context_snapshots WHERE id = ?")
      .get(att.context_snapshot_id) as { manifest_json: string } | undefined;
    if (!snap) continue;
    try {
      const manifest = JSON.parse(snap.manifest_json) as Array<{
        included: boolean; omittedReason?: string | null;
      }>;
      for (const item of manifest) {
        if (item.included) contextIncludedItemCount++;
        else {
          contextOmittedItemCount++;
          if (item.omittedReason === "budget") contextOmittedByBudgetCount++;
          if (item.omittedReason === "stale") staleRejectedCount++;
          if (item.omittedReason === "unverified") unverifiedRejectedCount++;
          if (item.omittedReason === "unrelated") unrelatedRejectedCount++;
        }
      }
    } catch { /* ok */ }
  }

  // rejectedOutputClaimCount: tasks with artifact_created but verification rejected
  const rejectedOutputClaimCount = attempts.filter(
    (a) => a.verification_status === "rejected"
  ).length;

  return {
    runId: conductorRunId,
    taskCount,
    attemptCount,
    completedTaskCount,
    failedTaskCount,
    verifiedInputCount,
    missingRequiredInputCount,
    upstreamInputReadCount,
    upstreamInputUnreadCount,
    contextIncludedItemCount,
    contextOmittedItemCount,
    contextOmittedByBudgetCount,
    staleRejectedCount,
    unverifiedRejectedCount,
    unrelatedRejectedCount,
    evidenceCount,
    toolCallCount,
    failedToolCallCount,
    verifiedOutputBindingCount,
    rejectedOutputClaimCount,
    artifactCreatedCount,
    deploymentReadyCount,
  };
}

// ── Derived rates ───────────────────────────────────────────────────────────

export function computeDerivedRates(raw: ContextQualityRunMetrics): ContextQualityDerivedRates {
  const totalCandidates = raw.contextIncludedItemCount + raw.contextOmittedItemCount;
  const totalOutputClaims = raw.verifiedOutputBindingCount + raw.rejectedOutputClaimCount;

  return {
    upstreamInputHitRate: safeRatio(raw.verifiedInputCount, raw.verifiedInputCount + raw.missingRequiredInputCount),
    upstreamArtifactReadRate: safeRatio(raw.upstreamInputReadCount, raw.verifiedInputCount),
    contextOmissionRate: safeRatio(raw.contextOmittedItemCount, totalCandidates),
    unverifiedOutputRejectionRate: safeRatio(raw.rejectedOutputClaimCount, totalOutputClaims),
    toolFailureRate: safeRatio(raw.failedToolCallCount, raw.toolCallCount),
    taskRetryRate: safeRatio(raw.attemptCount - raw.taskCount, raw.taskCount),
    deploymentSuccessRate: safeRatio(raw.deploymentReadyCount, raw.artifactCreatedCount),
    taskCompletionRate: safeRatio(raw.completedTaskCount, raw.taskCount),
  };
}

function safeRatio(numerator: number, denominator: number): number {
  if (denominator === 0) return 0;
  return Math.round((numerator / denominator) * 1000) / 1000;
}
