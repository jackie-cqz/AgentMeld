// ---------------------------------------------------------------------------
// Task Context types — Context Envelope, Manifest, and Failure Context
//
// Full definitions will be completed in P2 (Context Compiler).
// P0 establishes the minimal types needed for the AdapterInput / ToolContext
// contract so the identity chain can be threaded through.
// ---------------------------------------------------------------------------

import type { EvidenceTrustLevel, CriterionValidator, CriterionVerdict } from "@/shared/evidence-types";

// ── Context Facts ──────────────────────────────────────────────────────────

export interface ContextFact {
  id: string;
  kind: "goal" | "constraint" | "decision" | "user_answer" | "workspace_state";
  content: string;
  sourceType: "message" | "summary" | "evidence" | "plan";
  sourceId: string;
  trustLevel: EvidenceTrustLevel;
  status: "active" | "superseded" | "resolved";
  updatedAt: number;
}

// ── Verified Input ─────────────────────────────────────────────────────────

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

// ── Failure Context ────────────────────────────────────────────────────────

export interface FailureContext {
  previousAttemptId: string;
  previousChildRunId: string;
  failedCriteria: CriterionVerdict[];
  failedEvidenceIds: string[];
  failedCommands: Array<{
    command: string;
    exitCode: number | null;
    errorExcerpt: string;
    evidenceId: string;
  }>;
  missingOutputs: string[];
  changedFiles: Array<{
    path: string;
    contentHash: string | null;
    evidenceId: string;
  }>;
  retryInstructions: string[];
}

// ── Context Manifest ───────────────────────────────────────────────────────

export interface ContextManifestItem {
  id: string;
  category:
    | "task"
    | "constraint"
    | "upstream_input"
    | "workspace"
    | "evidence_contract"
    | "failure"
    | "retrieved_history";
  sourceType: string;
  sourceId: string;
  reason: string;
  required: boolean;
  trustLevel: EvidenceTrustLevel;
  tokenEstimate: number;
  included: boolean;
  omittedReason: "budget" | "stale" | "unverified" | "unrelated" | null;
}

// ── Task Context Envelope (minimal P0 shape) ───────────────────────────────

/**
 * Immutable context snapshot compiled for a single task attempt.
 * P0 stores a minimal envelope; full compilation lands in P2.
 */
export interface TaskContextEnvelope {
  schemaVersion: 1;
  policyVersion: string;
  identity: {
    conductorRunId: string;
    planId: string;
    planRevision: number;
    taskId: string;
    attemptId: string;
    attempt: number;
    contextSnapshotId: string;
  };
  task: {
    title: string;
    objective: string;
    assignedAgentId: string;
    dependsOn: string[];
  };
  requirements: {
    constraints: ContextFact[];
    expectedOutputs: Array<{
      outputKey: string;
      type: string;
      required: boolean;
      description?: string;
    }>;
  };
  upstreamInputs: VerifiedTaskInput[];
  failureContext: FailureContext | null;
  manifest: ContextManifestItem[];
  budget: {
    maxInputTokens: number;
    requiredTokens: number;
    optionalTokens: number;
    omittedTokens: number;
  };
  createdAt: number;
}
