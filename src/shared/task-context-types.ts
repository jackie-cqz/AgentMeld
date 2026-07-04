// P0+P3: Task context types
import type { EvidenceTrustLevel } from "@/shared/evidence-types";

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
  createdAt: number;
}
