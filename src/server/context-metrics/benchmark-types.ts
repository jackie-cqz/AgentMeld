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
  aliases?: string[];
  requiredAbsent?: boolean;
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

export interface ToolRejectedAssertion extends BenchmarkAssertionBase {
  type: "tool_rejected";
  toolName: string;
  role?: BenchmarkRole;
  category?: "security_policy" | "approval_rejected" | "tool_error";
  reasonPattern?: string;
}

export interface WarningPresentAssertion extends BenchmarkAssertionBase {
  type: "warning_present";
  code: string;
  role?: BenchmarkRole;
}

export interface FaultInjectedAssertion extends BenchmarkAssertionBase {
  type: "fault_injected";
  faultId: string;
}

export interface ApprovalResolvedAssertion extends BenchmarkAssertionBase {
  type: "approval_resolved";
  approvalType: BenchmarkApprovalType;
  decision: "approved" | "rejected";
  role?: BenchmarkRole;
  match?: string;
}

export interface DeploymentReadyAssertion extends BenchmarkAssertionBase {
  type: "deployment_ready";
  role?: BenchmarkRole;
  outputKey?: string;
}

export interface ArtifactValidAssertion extends BenchmarkAssertionBase {
  type: "artifact_valid";
  role: BenchmarkRole;
  outputKey: string;
  artifactType: BenchmarkArtifactType;
  minContentBytes?: number;
  requiredFiles?: string[];
  requiredContentPatterns?: string[];
  requireUniqueBinding?: boolean;
}

export interface BuildSucceededAssertion extends BenchmarkAssertionBase {
  type: "build_succeeded";
  role?: BenchmarkRole;
  commandPattern?: string;
}

export interface PreviewHttpAssertion extends BenchmarkAssertionBase {
  type: "preview_http";
  role?: BenchmarkRole;
  outputKey?: string;
  expectedStatus?: number;
  minBodyBytes?: number;
}

export interface BrowserInteractionAssertion extends BenchmarkAssertionBase {
  type: "browser_interaction";
  scriptId: string;
}

export interface RetryBoundAssertion extends BenchmarkAssertionBase {
  type: "retry_bound";
  role?: BenchmarkRole;
  minAttempts?: number;
  maxAttempts?: number;
}

export interface ToolRetryBoundAssertion extends BenchmarkAssertionBase {
  type: "tool_retry_bound";
  role?: BenchmarkRole;
  toolName: string;
  commandPattern?: string;
  minCalls?: number;
  maxCalls?: number;
  requireFailureBeforeSuccess?: boolean;
}

export interface VerificationStatusAssertion extends BenchmarkAssertionBase {
  type: "verification_status";
  role?: BenchmarkRole;
  expected: "verified" | "rejected" | "needs_review";
  warningCode?: string;
}

export interface CommandVerifierAssertion extends BenchmarkAssertionBase {
  type: "command_verifier";
  verifierId: string;
}

export interface WorkspaceFileAssertion extends BenchmarkAssertionBase {
  type: "workspace_file";
  path: string;
  minBytes?: number;
  contentPatterns?: string[];
}

export interface StructuredOutputAssertion extends BenchmarkAssertionBase {
  type: "structured_output";
  path: string;
  format: "json" | "jsonl" | "csv";
  requiredKeys?: string[];
}

export interface NoForbiddenMutationAssertion extends BenchmarkAssertionBase {
  type: "no_forbidden_mutation";
  paths: string[];
}

export interface ConsultationReflectedAssertion extends BenchmarkAssertionBase {
  type: "consultation_reflected";
  role: BenchmarkRole;
  outputKey: string;
  artifactType: BenchmarkArtifactType;
  /**
   * Regex used to pull the distinctive token out of the peer's recorded answer.
   * The produced artifact must contain at least one token captured from the
   * actual reply, which the producing role could not have known in advance.
   */
  answerPattern: string;
}

export interface ConsultationLifecycleAssertion extends BenchmarkAssertionBase {
  type: "consultation_lifecycle";
  role: BenchmarkRole;
  requireReplied?: boolean;
  requirePeerTornDown?: boolean;
  requireLeaseRestored?: boolean;
  requireReplayBounded?: boolean;
  requireNoExpired?: boolean;
}

export type BenchmarkAssertion =
  | RoleExecutedAssertion
  | DagEdgeAssertion
  | OutputBindingAssertion
  | ArtifactReadAssertion
  | ToolSucceededAssertion
  | ToolRejectedAssertion
  | WarningPresentAssertion
  | FaultInjectedAssertion
  | ApprovalResolvedAssertion
  | DeploymentReadyAssertion
  | ArtifactValidAssertion
  | BuildSucceededAssertion
  | PreviewHttpAssertion
  | BrowserInteractionAssertion
  | RetryBoundAssertion
  | ToolRetryBoundAssertion
  | VerificationStatusAssertion
  | CommandVerifierAssertion
  | WorkspaceFileAssertion
  | StructuredOutputAssertion
  | NoForbiddenMutationAssertion
  | ConsultationReflectedAssertion
  | ConsultationLifecycleAssertion;

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
  /** Number of matching approvals this entry may resolve, including recovery attempts. */
  maxMatches?: number;
}

export interface BenchmarkUserScript {
  questions?: BenchmarkQuestionScriptEntry[];
  approvals?: BenchmarkApprovalScriptEntry[];
  onUnmatchedQuestion?: "first_option" | "fail";
  onUnmatchedApproval?: "approve" | "reject" | "fail";
}

export interface BenchmarkRuntimeConfig {
  fsWriteApprovalMode?: "auto" | "review";
  workspaceFiles?: BenchmarkWorkspaceFile[];
  assetBundle?: BenchmarkAssetBundle;
  verifiers?: BenchmarkCommandVerifier[];
  userScript?: BenchmarkUserScript;
  browserScripts?: BenchmarkBrowserScript[];
  faults?: BenchmarkFaultSpec[];
}

export interface BenchmarkAssetBundle {
  /** Repository-relative root under tests/e2e-assets. */
  root: string;
  publicDir?: string;
  hiddenDir?: string;
  /** Trusted repository-side commands that materialize generated fixture assets before seeding. */
  setupCommands?: BenchmarkAssetSetupCommand[];
  /** Generated assets merged into the Agent-visible workspace after publicDir. */
  generatedPublicDir?: string;
  /** Generated assets merged into .benchmark/hidden only while verifiers run. */
  generatedHiddenDir?: string;
}

export interface BenchmarkAssetSetupCommand {
  id: string;
  command: string;
  timeoutMs?: number;
}

export interface BenchmarkCommandVerifier {
  id: string;
  command: string;
  timeoutMs?: number;
  expectedExitCode?: number;
}

export interface BenchmarkWorkspaceFile {
  /** Portable path relative to the benchmark conversation workspace. */
  path: string;
  content: string;
}

export interface BenchmarkFaultSpec {
  id: string;
  type:
    | "tool_arguments_json"
    | "tool_failure"
    | "command_nonzero"
    | "deployment_missing"
    | "task_report_fake_deployment"
    | "sse_disconnect"
    | "child_run_abort";
  toolName: string;
  occurrence?: number;
  commandPattern?: string;
  message?: string;
}

export interface BenchmarkFaultRecord {
  id: string;
  type: BenchmarkFaultSpec["type"];
  toolName: string;
  occurrence: number;
  runId: string;
  taskId: string | null;
  injectedAt: number;
  detail: string;
}

export type BenchmarkBrowserStep =
  | { action: "fill"; selector: string; value: string }
  | { action: "click"; selector: string }
  | { action: "press"; selector: string; key: string }
  | { action: "check"; selector: string }
  | { action: "select_option"; selector: string; index: number }
  | { action: "wait"; timeoutMs: number }
  | { action: "reload" }
  | { action: "navigate"; path: string }
  | { action: "advance_clock"; timeoutMs: number }
  | { action: "assert_storage"; key?: string; valuePattern?: string; minEntries?: number; timeoutMs?: number }
  | { action: "assert_text"; text: string }
  | { action: "assert_visible"; selector: string }
  | { action: "assert_hidden"; selector: string }
  | { action: "assert_dom_changed" };

export interface BenchmarkBrowserScript {
  id: string;
  outputKey?: string;
  timeoutMs?: number;
  initialTimeMs?: number;
  steps: BenchmarkBrowserStep[];
}

export interface BenchmarkArtifactValidation {
  taskId: string;
  outputKey: string;
  artifactId: string;
  artifactType: string;
  title: string;
  contentBytes: number;
  contentText?: string;
  files: string[];
  valid: boolean;
  errors: string[];
}

export interface BenchmarkBuildValidation {
  taskId: string;
  attemptId?: string;
  evidenceId: string;
  toolCallId?: string;
  command: string;
  exitCode: number;
  timedOut: boolean;
  status: string;
  outputExcerpt: string;
}

export interface BenchmarkDeploymentValidation {
  taskId: string;
  attemptId?: string;
  outputKey: string;
  artifactId: string;
  evidenceId: string | null;
  toolCallId: string | null;
  previewPath: string;
  previewUrl: string;
  ready: boolean;
  supersededEvidenceIds?: string[];
}

export interface BenchmarkPreviewValidation {
  outputKey: string;
  artifactId: string;
  previewUrl: string;
  status: number | null;
  bodyBytes: number;
  contentType: string | null;
  error: string | null;
}

export interface BenchmarkBrowserStepResult {
  index: number;
  action: BenchmarkBrowserStep["action"];
  status: "passed" | "failed";
  detail: string;
}

export interface BenchmarkBrowserValidation {
  scriptId: string;
  outputKey: string;
  previewUrl: string;
  status: "passed" | "failed" | "blocked";
  steps: BenchmarkBrowserStepResult[];
  consoleErrors: string[];
  pageErrors: string[];
  failedRequests: string[];
  screenshotPath: string | null;
  error: string | null;
}

export interface BenchmarkToolRejectionValidation {
  runId: string;
  taskId: string | null;
  attemptId?: string;
  callId: string;
  toolName: string;
  category: "security_policy" | "approval_rejected" | "tool_error";
  code?: string;
  reason: string;
  conflictingSuccessEvidenceIds?: string[];
}

export interface BenchmarkToolCallValidation {
  runId: string;
  taskId: string | null;
  attemptId?: string;
  callId: string;
  toolName: string;
  args: unknown;
  status: "succeeded" | "failed" | "pending";
  result: unknown;
  sequence: number;
}

export interface BenchmarkApprovalValidation {
  id: string;
  runId: string;
  taskId: string | null;
  approvalType: BenchmarkApprovalType;
  status: string;
  payload: string;
}

export interface BenchmarkConsultationValidation {
  id: string;
  sourceRunId: string;
  sourceAgentId: string;
  /** Inferred from the dispatched task that owns the source run. */
  sourceRole: BenchmarkRole | null;
  targetAgentId: string;
  targetRunId: string | null;
  requestKey: string;
  status: string;
  answer: string | null;
  peerRunStatus: string | null;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
}

export interface BenchmarkWorkspaceLeaseValidation {
  workspaceKey: string;
  held: boolean;
  poisoned: boolean;
  childPid: number | null;
}

export interface BenchmarkRuntimeValidation {
  collectedAt: number;
  artifacts: BenchmarkArtifactValidation[];
  builds: BenchmarkBuildValidation[];
  deployments: BenchmarkDeploymentValidation[];
  previews: BenchmarkPreviewValidation[];
  browsers: BenchmarkBrowserValidation[];
  toolRejections: BenchmarkToolRejectionValidation[];
  toolCalls?: BenchmarkToolCallValidation[];
  injectedFaults: BenchmarkFaultRecord[];
  approvals: BenchmarkApprovalValidation[];
  consultations?: BenchmarkConsultationValidation[];
  workspaceLease?: BenchmarkWorkspaceLeaseValidation | null;
  verifiers?: BenchmarkVerifierValidation[];
  workspaceFiles?: BenchmarkWorkspaceFileValidation[];
  structuredOutputs?: BenchmarkStructuredOutputValidation[];
  mutations?: BenchmarkMutationValidation[];
}

export interface BenchmarkVerifierValidation {
  verifierId: string;
  command: string;
  status: "passed" | "failed" | "error";
  exitCode: number | null;
  expectedExitCode: number;
  timedOut: boolean;
  durationMs: number;
  stdout: string;
  stderr: string;
  error: string | null;
}

export interface BenchmarkWorkspaceFileValidation {
  path: string;
  exists: boolean;
  isFile: boolean;
  bytes: number;
  sha256: string | null;
  contentText: string | null;
  error: string | null;
}

export interface BenchmarkStructuredOutputValidation {
  path: string;
  format: StructuredOutputAssertion["format"];
  valid: boolean;
  recordCount: number;
  keys: string[];
  errors: string[];
}

export interface BenchmarkMutationValidation {
  path: string;
  beforeSha256: string | null;
  afterSha256: string | null;
  unchanged: boolean;
  error: string | null;
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
  judge?: BenchmarkJudgeConfig;
  tags: string[];
}

export interface BenchmarkJudgeConfig {
  enabled: boolean;
  requiredForPass?: boolean;
  rubricVersion?: string;
  dimensions?: string[];
}

export interface AssertionReference {
  runId?: string;
  taskId?: string;
  attemptId?: string;
  contextSnapshotId?: string;
  evidenceId?: string;
  artifactId?: string;
  toolCallId?: string;
  url?: string;
  filePath?: string;
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
  taskRetryCount: number;
  toolRetryCount: number;
  /** @deprecated Use taskRetryCount. */
  retryCount: number;

  planValid: boolean;
  expectedRoleCoverage: number;
  expectedOutputCoverage: number;

  verifiedInputCount: number;
  verifiedInputCoverage: number;
  upstreamArtifactReadRate: number;
  contextOmissionRate: number;
  contextIncludedItemCount: number;
  contextOmittedItemCount: number;
  contextOmittedReasonCounts: Record<string, number>;
  staleFactRejectedCount: number;
  unverifiedOutputBlockedCount: number;
  unverifiedOutputPropagationCount: number;

  toolCallCount: number;
  toolFailureRate: number;
  approvalRequestCount: number;
  jsonRepairCount: number;

  artifactCreatedCount: number;
  deploymentReady: boolean;
  reviewerPassed: boolean;

  inputTokens: number;
  outputTokens: number;
  modelRunCount: number;
  /** @deprecated Kept in report JSON compatibility; equals inputTokens. */
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
