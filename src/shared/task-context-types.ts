// P0+P3+P6: Task context types
import type { EvidenceTrustLevel } from "@/shared/evidence-types";
import type { TaskState } from "@/server/task-state/task-state-types";

// ── P6: Cross-agent context propagation ─────────────────────────────────────

/** A verified input that a downstream task can consume as fact. */
export interface VerifiedTaskInput {
  fromTaskId: string;
  outputKey: string;
  artifactId: string;
  artifactVersion: number;
  artifactType: string;
  title: string;
  verificationId: string;
  evidenceIds: string[];
}

/** Structured delta produced by a verified task for downstream consumption. */
export interface TaskContextDelta {
  taskId: string;
  verifiedAttemptId: string;
  acceptedDecisions: Array<{ canonicalKey: string; value: unknown; trustLevel: EvidenceTrustLevel }>;
  artifactOutputs: VerifiedTaskInput[];
  workspaceChanges: Array<{ path: string; contentHash: string; evidenceId: string }>;
  resolvedConstraints: string[];
  remainingRisks: string[];
}

// ── P8: Context quality metrics ─────────────────────────────────────────────

export interface ContextQualityMetrics {
  totalTokens: number;
  requiredTokens: number;
  optionalTokens: number;
  omittedTokens: number;
  includedItemCount: number;
  staleItemRejectedCount: number;
  unverifiedItemRejectedCount: number;
  unrelatedItemRejectedCount: number;
  verifiedInputCount: number;
  retrievalHitCount: number;
}

// ── P3: Core context types ──────────────────────────────────────────────────

export interface ContextManifestItem {
  id: string;
  category: "task" | "constraint" | "upstream_input" | "workspace" | "evidence_contract" | "failure" | "retrieved_history" | "fact" | "evidence" | "recent_message";
  sourceType: string;
  sourceId: string;
  reason: string;
  required: boolean;
  trustLevel: EvidenceTrustLevel;
  tokenEstimate: number;
  included: boolean;
  omittedReason: "budget" | "stale" | "unverified" | "unrelated" | null;
}

export interface ContextItem {
  category: string;
  sourceType: string;
  sourceId: string;
  content: unknown;
  trustLevel: EvidenceTrustLevel;
  required: boolean;
  tokenEstimate: number;
}

export interface FailureContext {
  previousAttemptId: string;
  previousChildRunId: string;
  failedCriteria: Array<{ criterionId: string; status: string; evidenceIds: string[]; reason: string }>;
  failedEvidenceIds: string[];
  failedCommands: Array<{ command: string; exitCode: number | null; errorExcerpt: string; evidenceId: string }>;
  missingOutputs: string[];
  changedFiles: Array<{ path: string; contentHash: string | null; evidenceId: string }>;
  retryInstructions: string[];
}

export interface TaskContextEnvelope {
  schemaVersion: 1;
  policyVersion: string;
  /** P3: When true, mandatory context exceeded budget — do NOT call the model */
  blocked: boolean;
  identity: { conductorRunId: string; planId: string; planRevision: number; taskId: string; attemptId: string; attempt: number; contextSnapshotId: string };
  task: { title: string; objective: string; assignedAgentId: string; dependsOn: string[] };
  requirements: { constraints: unknown[]; expectedOutputs: Array<{ outputKey: string; type: string; required: boolean; description?: string }> };
  upstreamInputs: unknown[];
  /** P3: Items that survived packing — these ARE the context the model receives */
  includedContextItems: ContextItem[];
  failureContext: FailureContext | null;
  manifest: ContextManifestItem[];
  budget: { maxInputTokens: number; requiredTokens: number; optionalTokens: number; omittedTokens: number };
  /** P1: Structured task state for model context */
  taskState?: TaskState;
  /** P8: Context quality metrics for offline evaluation and observability */
  qualityMetrics?: ContextQualityMetrics;
  createdAt: number;
}
