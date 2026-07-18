export type JudgeMode = "off" | "manual_codex" | "api";

export interface JudgeEvidenceReference {
  id: string;
  kind: "artifact" | "task" | "assertion" | "browser" | "evidence" | "message";
  label: string;
}

export interface JudgePacketArtifact {
  evidenceRef: string;
  outputKey: string;
  artifactId: string;
  type: string;
  title: string;
  content: unknown;
}

export interface JudgePacket {
  schemaVersion: 1 | 2;
  packetHash: string;
  caseId: string;
  title: string;
  prompt: string;
  expectedRoles: string[];
  deterministicAssertions: Array<{ id: string; type: string; required: boolean; status: string; reason: string; evidenceRefs: string[] }>;
  tasks: Array<{ evidenceRef: string; taskId: string; title: string; agentId: string; status: string; verificationStatus: string; dependsOn: string[] }>;
  artifacts: JudgePacketArtifact[];
  runtime: unknown;
  evidenceReferences: JudgeEvidenceReference[];
  generatedAt?: number;
  finalSummary?: {
    messageId: string;
    runId: string;
    createdAt: number;
    content: string;
    evidenceRef: string;
  } | null;
  finalSummaryMissing?: boolean;
  claimConflicts?: Array<{
    type: string;
    claim: string;
    reason: string;
    evidenceRefs: string[];
  }>;
  securityNotice: string;
}

export interface JudgeDimensionScore {
  dimension: string;
  score: 0 | 1 | 2 | 3 | 4;
  reason: string;
  evidenceRefs: string[];
}

export interface JudgeResult {
  schemaVersion: 1;
  provider: string;
  model: string;
  promptVersion: string;
  rubricVersion: string;
  packetHash: string;
  dimensions: JudgeDimensionScore[];
  weightedScore: number;
  verdict: "passed" | "failed" | "needs_human_review";
  confidence: number;
  summary: string;
  tokenUsage?: { inputTokens: number; outputTokens: number };
  estimatedCostUsd?: number;
  createdAt: number;
}

export interface JudgeExecution {
  mode: JudgeMode;
  status: "disabled" | "pending" | "completed" | "failed";
  packetPath: string | null;
  resultPath: string | null;
  packetHash: string | null;
  result: JudgeResult | null;
  error: string | null;
  fromCache: boolean;
  sampleResults?: JudgeResult[];
  disagreement?: boolean;
}

export interface ComposedVerdict {
  deterministicVerdict: "passed" | "failed" | "error" | "blocked" | "budget_exceeded";
  semanticVerdict: "not_requested" | "pending" | "passed" | "failed" | "needs_human_review" | "error";
  finalVerdict: "passed" | "failed" | "blocked" | "needs_human_review";
  reason: string;
}
