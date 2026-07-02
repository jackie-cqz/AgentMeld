// ---------------------------------------------------------------------------
// Evidence-aware Context Engineering — shared type contracts
//
// These types define the core identity, evidence, and verification data model
// used across the Conductor runtime, tool layer, and API surface.
// ---------------------------------------------------------------------------

// ── Task Execution Identity ────────────────────────────────────────────────

/**
 * Stable identity that travels with every child run from Conductor through
 * Adapter into ToolContext, so tool handlers and evidence collectors can
 * attribute every action to a specific plan / task / attempt.
 */
export interface TaskExecutionIdentity {
  conductorRunId: string;
  planId: string;
  planRevision: number;
  taskId: string;
  attemptId: string;
  attempt: number;
  contextSnapshotId: string;
}

// ── Evidence ────────────────────────────────────────────────────────────────

export type EvidenceType =
  | "file_read"
  | "file_written"
  | "command_executed"
  | "test_executed"
  | "artifact_read"
  | "artifact_created"
  | "artifact_version_created"
  | "deployment_created"
  | "deployment_checked"
  | "approval_resolved"
  | "user_answered"
  | "task_reported";

export type EvidenceStatus =
  | "valid"
  | "invalid"
  | "stale"
  | "diagnostic";

export type EvidenceTrustLevel =
  | "authoritative"   // L0: user confirmation, system config, approval result
  | "verified"        // L1: tool execution result, file hash, command exit code
  | "accepted"        // L2: task output that passed criterion verification
  | "reported"        // L3: agent's report_task_result self-report
  | "retrieved";      // L4: recalled from history / search

// ── Criterion Validators ───────────────────────────────────────────────────

export type CriterionValidator =
  | { type: "file_exists"; path: string }
  | { type: "file_changed"; path: string }
  | { type: "command_exit"; command: string; expectedExitCode: number }
  | { type: "artifact_exists"; outputKey: string; artifactType?: string }
  | { type: "deployment_created"; outputKey?: string }
  | { type: "user_confirmation" }
  | { type: "reviewer_verdict"; reviewerAgentId?: string };

// ── Verdict ─────────────────────────────────────────────────────────────────

export interface CriterionVerdict {
  id: string;
  criterionId: string;
  status: "passed" | "failed" | "missing" | "needs_review";
  validatorType: CriterionValidator["type"];
  evidenceIds: string[];
  reason: string;
  checkedAt: number;
}
