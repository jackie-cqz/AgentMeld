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
  caseId: string;
  runId: string;
  startedAt: number;
  finishedAt: number;
  durationMs: number;
  strategy: string;
  taskCount: number;
  attemptCount: number;
  completedTaskCount: number;
  failedTaskCount: number;
  verifiedInputCount: number;
  upstreamInputReadCount: number;
  upstreamInputUnreadCount: number;
  toolCallCount: number;
  failedToolCallCount: number;
  artifactCreatedCount: number;
  webAppOutputCount: number;
  deploymentReadyCount: number;
  contextIncludedItemCount: number;
  contextOmittedItemCount: number;
  derivedRates: ContextQualityDerivedRates;
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
