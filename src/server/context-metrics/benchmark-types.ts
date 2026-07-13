// ---------------------------------------------------------------------------
// Agent Benchmark contracts — canonical types shared by runners and reports
// ---------------------------------------------------------------------------

export const BENCHMARK_CASE_SCHEMA_VERSION = 1 as const;

export type BenchmarkRole = "conductor" | "pm" | "ui" | "frontend" | "reviewer";
export type BenchmarkArtifactType = "web_app" | "document" | "image" | "ppt";
export type BenchmarkCaseCategory =
  | "collaboration"
  | "context_handoff"
  | "fact_update"
  | "recovery"
  | "safety"
  | "false_completion";

export interface BenchmarkAssertionBase {
  id: string;
  required: boolean;
  weight?: number;
  description?: string;
}

export interface RoleExecutedAssertion extends BenchmarkAssertionBase {
  type: "role_executed";
  role: BenchmarkRole;
  mustComplete?: boolean;
}

export interface DagEdgeAssertion extends BenchmarkAssertionBase {
  type: "dag_edge";
  fromRole: BenchmarkRole;
  toRole: BenchmarkRole;
  outputKey?: string;
}

export interface OutputBindingAssertion extends BenchmarkAssertionBase {
  type: "output_binding";
  role: BenchmarkRole;
  outputKey: string;
  artifactType: BenchmarkArtifactType;
}

export interface ArtifactReadAssertion extends BenchmarkAssertionBase {
  type: "artifact_read";
  producerRole: BenchmarkRole;
  consumerRole: BenchmarkRole;
  outputKey: string;
  requireVerifiedBinding?: boolean;
}

export interface ToolSucceededAssertion extends BenchmarkAssertionBase {
  type: "tool_succeeded";
  toolName: string;
  role?: BenchmarkRole;
  commandPattern?: string;
}

export interface DeploymentReadyAssertion extends BenchmarkAssertionBase {
  type: "deployment_ready";
  role?: BenchmarkRole;
  outputKey?: string;
}

export interface RetryBoundAssertion extends BenchmarkAssertionBase {
  type: "retry_bound";
  role?: BenchmarkRole;
  minAttempts?: number;
  maxAttempts?: number;
}

export type BenchmarkAssertion =
  | RoleExecutedAssertion
  | DagEdgeAssertion
  | OutputBindingAssertion
  | ArtifactReadAssertion
  | ToolSucceededAssertion
  | DeploymentReadyAssertion
  | RetryBoundAssertion;

export interface BenchmarkCaseLimits {
  maxDurationMs: number;
  maxModelCalls?: number;
  maxToolCalls?: number;
  maxInputTokens?: number;
  maxAttemptsPerTask?: number;
}

export type BenchmarkApprovalType = "dispatch_plan" | "fs_write" | "bash";

export interface BenchmarkQuestionScriptEntry {
  /** Case-insensitive substring matched against question headers and text. */
  match?: string;
  /** ask_user answers keyed by the zero-based question index. */
  answers: Record<string, string>;
}

export interface BenchmarkApprovalScriptEntry {
  type: BenchmarkApprovalType;
  /** Case-insensitive substring matched against the plan, path, or command. */
  match?: string;
  decision: "approve" | "reject";
}

export interface BenchmarkUserScript {
  questions?: BenchmarkQuestionScriptEntry[];
  approvals?: BenchmarkApprovalScriptEntry[];
  onUnmatchedQuestion?: "first_option" | "fail";
  onUnmatchedApproval?: "approve" | "reject" | "fail";
}

export interface BenchmarkRuntimeConfig {
  fsWriteApprovalMode?: "auto" | "review";
  userScript?: BenchmarkUserScript;
}

export interface AgentBenchmarkCase {
  schemaVersion: typeof BENCHMARK_CASE_SCHEMA_VERSION;
  id: string;
  title: string;
  description: string;
  category: BenchmarkCaseCategory;
  prompt: string;
  expectedRoles: BenchmarkRole[];
  assertions: BenchmarkAssertion[];
  limits: BenchmarkCaseLimits;
  runtime?: BenchmarkRuntimeConfig;
  tags: string[];
}

export interface AssertionReference {
  runId?: string;
  taskId?: string;
  attemptId?: string;
  contextSnapshotId?: string;
  evidenceId?: string;
  artifactId?: string;
  toolCallId?: string;
}

export interface AssertionResult {
  assertionId: string;
  type: BenchmarkAssertion["type"];
  required: boolean;
  status: "passed" | "failed" | "blocked" | "not_applicable";
  score: number;
  maxScore: number;
  reason: string;
  references: AssertionReference[];
}

export interface AgentBenchmarkMetrics {
  success: boolean;
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

  planValid: boolean;
  expectedRoleCoverage: number;
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
