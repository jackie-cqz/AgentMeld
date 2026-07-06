// ---------------------------------------------------------------------------
// P8: Agent Benchmark types — standardized multi-agent evaluation
// ---------------------------------------------------------------------------

import type { ContextQualityRunMetrics, ContextQualityDerivedRates } from "@/server/context-metrics/context-metrics-types";

export interface AgentBenchmarkCase {
  id: string;
  title: string;
  category: "web_app" | "document" | "workflow" | "debugging";
  userPrompt: string;
  expectedRoles: Array<"conductor" | "pm" | "ui" | "frontend" | "reviewer">;
  expectedOutputs: Array<{
    taskRole: string;
    outputKey: string;
    artifactType: string;
    required: boolean;
  }>;
  requiredToolEvidence: string[];
  /** Edges that MUST exist between tasks for context propagation */
  requiredContextEdges: Array<{
    fromRole: string;
    toRole: string;
    outputKey: string;
    mustBeRead: boolean;
  }>;
  successCriteria: string[];
  maxAttempts?: number;
  maxDurationMs?: number;
}

export interface AgentBenchmarkMetrics {
  success: boolean;
  /** P8: Granular final status — passed / partial / failed / blocked */
  finalStatus: "passed" | "failed" | "partial" | "blocked";
  caseId: string;
  runId: string;
  startedAt: number;
  finishedAt: number;
  durationMs: number;
  strategy: string;

  taskCount: number;
  completedTaskCount: number;
  failedTaskCount: number;
  retryCount: number;

  /** Whether the conductor generated a valid DAG */
  planValid: boolean;
  /** Ratio of expected roles that were assigned tasks */
  expectedRoleCoverage: number;
  /** Ratio of expected outputs that were actually produced */
  expectedOutputCoverage: number;

  verifiedInputCount: number;
  verifiedInputCoverage: number;
  upstreamArtifactReadRate: number;
  contextOmissionRate: number;
  staleFactRejectedCount: number;
  unverifiedOutputBlockedCount: number;

  toolCallCount: number;
  toolFailureRate: number;
  approvalRequestCount: number;
  jsonRepairCount: number;

  artifactCreatedCount: number;
  deploymentReady: boolean;
  reviewerPassed: boolean;

  estimatedInputTokens: number;

  /** Whether all requiredContextEdges were satisfied */
  edgesSatisfied: boolean;
  missingEdges: string[];
  warnings: string[];
}

export interface AgentBenchmarkReport {
  generatedAt: number;
  strategy: string;
  totalCases: number;
  passed: number;
  failed: number;
  errors: number;
  overallSuccessRate: number;
  cases: AgentBenchmarkMetrics[];
}
