// ---------------------------------------------------------------------------
// P0: Context Trace — diagnostic types for context observability
// ---------------------------------------------------------------------------

import type { ContextManifestItem } from "@/shared/task-context-types";

// ── Attempt-level trace ────────────────────────────────────────────────────

export interface ContextTraceAttempt {
  conversationId: string;
  conductorRunId: string;
  planId: string;
  taskId: string;
  attemptId: string;
  agentId: string;
  contextSnapshotId: string | null;
  executionStatus: string;
  verificationStatus: string;
  startedAt: number | null;
  finishedAt: number | null;
}

export interface ContextTraceSnapshot {
  id: string;
  policyVersion: string;
  schemaVersion: number;
  tokenEstimate: number;
  requiredTokenEstimate: number;
  omittedTokenEstimate: number;
  manifest: ContextManifestItem[];
}

export interface ContextTraceUpstreamInput {
  fromTaskId: string;
  outputKey: string;
  artifactId: string;
  artifactTitle: string;
  artifactType: string;
  artifactVersion: number;
  /** Whether the output binding was verified by the verification engine */
  bindingVerified: boolean;
  /** Whether the current attempt's child run called read_artifact for this artifact */
  readByCurrentAttempt: boolean;
}

export interface ContextTraceEvidenceSummary {
  evidenceId: string;
  type: string;
  status: string;
  trustLevel: string;
  subjectType: string;
  subjectId: string;
  /** First 200 chars of sanitized payload */
  excerpt: string;
  createdAt: number;
}

export interface ContextTraceVerdictSummary {
  id: string;
  criterionId: string;
  validatorType: string;
  status: string;
  evidenceIds: string[];
  reason: string;
}

export interface ContextTraceOutputBinding {
  producerTaskId: string;
  outputKey: string;
  artifactId: string;
  artifactTitle: string;
  artifactType: string;
  createdAt: number;
}

// ── Warnings ────────────────────────────────────────────────────────────────

export type ContextTraceWarningCode =
  | "missing_context_snapshot"
  | "missing_required_upstream_input"
  | "unread_verified_input"
  | "guessed_artifact_id"
  | "unverified_output_not_propagated"
  | "output_binding_missing"
  | "context_budget_omitted_high_priority"
  | "tool_claim_without_evidence";

export interface ContextTraceWarning {
  code: ContextTraceWarningCode;
  severity: "info" | "warning" | "error";
  message: string;
  taskId?: string;
  attemptId?: string;
  artifactId?: string;
}

// ── Response types ──────────────────────────────────────────────────────────

export interface ContextTraceResponse {
  attempt: ContextTraceAttempt;
  snapshot: ContextTraceSnapshot | null;
  upstreamInputs: ContextTraceUpstreamInput[];
  includedManifest: ContextManifestItem[];
  omittedManifest: ContextManifestItem[];
  evidence: ContextTraceEvidenceSummary[];
  verdicts: ContextTraceVerdictSummary[];
  outputBindings: ContextTraceOutputBinding[];
  warnings: ContextTraceWarning[];
  /** P0: Single diagnostic summary computed server-side from all trace data */
  diagnostic?: ContextTraceDiagnostic;
}

export interface ContextTraceDiagnostic {
  /** Short label for display: "✓ 正常", "⚠ 缺上游输入", etc. */
  label: string;
  /** Severity: normal, warning, error */
  severity: "normal" | "warning" | "error";
  /** Detailed explanation */
  detail: string;
}

// ── Run-level trace ─────────────────────────────────────────────────────────

export interface ContextTraceRunTask {
  taskId: string;
  agentId: string;
  title: string;
  dependsOn: string[];
  attempts: ContextTraceAttempt[];
  producedBindings: ContextTraceOutputBinding[];
  consumedInputs: ContextTraceUpstreamInput[];
}

export interface ContextTraceRunMetrics {
  taskCount: number;
  attemptCount: number;
  completedTaskCount: number;
  failedTaskCount: number;
  verifiedInputCount: number;
  missingRequiredInputCount: number;
  upstreamInputReadCount: number;
  upstreamInputUnreadCount: number;
  evidenceCount: number;
  verifiedOutputBindingCount: number;
  artifactCreatedCount: number;
  deploymentReadyCount: number;
}

export interface ContextTraceRunResponse {
  conductorRunId: string;
  conversationId: string;
  planId: string;
  tasks: ContextTraceRunTask[];
  metrics: ContextTraceRunMetrics;
}

// ── Artifact read detection result ─────────────────────────────────────────

export interface ArtifactReadResult {
  artifactId: string;
  readByChildRun: boolean;
  readEvidenceIds: string[];
}
