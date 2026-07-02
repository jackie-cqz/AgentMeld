// P0/P1: Evidence-aware types
export interface TaskExecutionIdentity {
  conductorRunId: string;
  planId: string;
  planRevision: number;
  taskId: string;
  attemptId: string;
  attempt: number;
  contextSnapshotId: string;
}

export type EvidenceTrustLevel = "authoritative" | "verified" | "accepted" | "reported" | "retrieved";
export type CriterionValidator =
  | { type: "file_exists"; path: string }
  | { type: "file_changed"; path: string }
  | { type: "command_exit"; command: string; expectedExitCode: number }
  | { type: "artifact_exists"; outputKey: string; artifactType?: string }
  | { type: "deployment_created"; outputKey?: string }
  | { type: "user_confirmation" }
  | { type: "reviewer_verdict"; reviewerAgentId?: string };
export interface CriterionVerdict {
  id: string; criterionId: string; status: "passed" | "failed" | "missing" | "needs_review";
  validatorType: CriterionValidator["type"]; evidenceIds: string[]; reason: string; checkedAt: number;
}
