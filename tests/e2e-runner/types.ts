import type {
  AgentBenchmarkCase,
  AssertionResult,
} from "@/server/context-metrics/benchmark-types";

export type E2EFixture = AgentBenchmarkCase;

export interface E2ERunResult {
  fixtureId: string;
  runId: string;
  startedAt: number;
  finishedAt: number;
  status: "passed" | "failed" | "error";
  strategy?: string;
  metrics: E2ERunMetrics;
  assertionResults: AssertionResult[];
  artifacts: Array<{ outputKey: string; artifactId: string; type: string; title: string }>;
  warnings: string[];
  error?: string;
}

export interface StrategyComparisonEntry {
  fixtureId: string;
  baseline: { strategy: string; status: string; metrics: Pick<E2ERunMetrics, "taskCount" | "attemptCount" | "completedTaskCount" | "upstreamInputReadCount" | "verifiedInputCount" | "failedToolCallCount" | "deploymentReadyCount"> };
  candidate: { strategy: string; status: string; metrics: Pick<E2ERunMetrics, "taskCount" | "attemptCount" | "completedTaskCount" | "upstreamInputReadCount" | "verifiedInputCount" | "failedToolCallCount" | "deploymentReadyCount"> };
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
  toolCallCount: number;
  failedToolCallCount: number;
  verifiedOutputBindingCount: number;
  rejectedOutputClaimCount: number;
  artifactCreatedCount: number;
  webAppOutputCount: number;
  deploymentReadyCount: number;
}

export type {
  AgentBenchmarkCase,
  AssertionResult,
  BenchmarkAssertion,
} from "@/server/context-metrics/benchmark-types";
