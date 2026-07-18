import type {
  AgentBenchmarkCase,
  AssertionResult,
} from "@/server/context-metrics/benchmark-types";
import type { ComposedVerdict, JudgeExecution } from "../agent-benchmark/judges/judge-types";

export type E2EFixture = AgentBenchmarkCase;

export interface E2ERunResult {
  fixtureId: string;
  runId: string;
  startedAt: number;
  finishedAt: number;
  status: "passed" | "failed" | "error" | "blocked" | "budget_exceeded";
  strategy?: string;
  metrics: E2ERunMetrics;
  assertionResults: AssertionResult[];
  artifacts: Array<{ outputKey: string; artifactId: string; type: string; title: string }>;
  warnings: string[];
  error?: string;
  judge?: JudgeExecution | null;
  verdict?: ComposedVerdict;
}

export interface StrategyComparisonEntry {
  fixtureId: string;
  baseline: { strategy: string; status: string; metrics: E2ERunMetrics };
  candidate: { strategy: string; status: string; metrics: E2ERunMetrics };
}

export interface StrategyComparisonReport {
  baselineStrategy: string;
  candidateStrategy: string;
  comparedAt: number;
  fixtures: StrategyComparisonEntry[];
  summary: {
    baselinePassRate: number;
    candidatePassRate: number;
    baselineAvgReadRate: number;
    candidateAvgReadRate: number;
    baselineAvgDeployRate: number;
    candidateAvgDeployRate: number;
    baselineContextOmissionRate: number;
    candidateContextOmissionRate: number;
  };
}

export interface E2ERunMetrics {
  taskCount: number;
  attemptCount: number;
  completedTaskCount: number;
  failedTaskCount: number;
  verifiedInputCount: number;
  missingRequiredInputCount: number;
  upstreamInputReadCount: number;
  upstreamInputUnreadCount: number;
  contextIncludedItemCount: number;
  contextOmittedItemCount: number;
  contextOmittedByBudgetCount: number;
  contextOmittedReasonCounts: Record<string, number>;
  staleRejectedCount: number;
  staleFactLeakageCount: number;
  unverifiedRejectedCount: number;
  unrelatedRejectedCount: number;
  toolCallCount: number;
  failedToolCallCount: number;
  toolRetryCount: number;
  approvalRequestCount: number;
  jsonRepairCount: number;
  inputTokens: number;
  outputTokens: number;
  modelRunCount: number;
  verifiedOutputBindingCount: number;
  rejectedOutputClaimCount: number;
  unverifiedOutputPropagationCount: number;
  expectedRoleCount: number;
  executedExpectedRoleCount: number;
  expectedOutputCount: number;
  verifiedExpectedOutputCount: number;
  reviewerPassed: boolean;
  artifactCreatedCount: number;
  webAppOutputCount: number;
  deploymentReadyCount: number;
}

export type {
  AgentBenchmarkCase,
  AssertionResult,
  BenchmarkAssertion,
} from "@/server/context-metrics/benchmark-types";
