// P0: Task context types
import type { EvidenceTrustLevel } from "@/shared/evidence-types";

export interface ContextManifestItem {
  id: string; category: "task"|"constraint"|"upstream_input"|"workspace"|"evidence_contract"|"failure"|"retrieved_history";
  sourceType: string; sourceId: string; reason: string; required: boolean;
  trustLevel: EvidenceTrustLevel; tokenEstimate: number; included: boolean;
  omittedReason: "budget"|"stale"|"unverified"|"unrelated"|null;
}

export interface TaskContextEnvelope {
  schemaVersion: 1; policyVersion: string;
  identity: { conductorRunId:string; planId:string; planRevision:number; taskId:string; attemptId:string; attempt:number; contextSnapshotId:string };
  task: { title:string; objective:string; assignedAgentId:string; dependsOn:string[] };
  requirements: { constraints: unknown[]; expectedOutputs: Array<{outputKey:string;type:string;required:boolean;description?:string}> };
  upstreamInputs: unknown[]; failureContext: unknown | null;
  manifest: ContextManifestItem[];
  budget: { maxInputTokens:number; requiredTokens:number; optionalTokens:number; omittedTokens:number };
  createdAt: number;
}
