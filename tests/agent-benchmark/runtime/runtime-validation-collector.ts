import fs from "node:fs";
import http from "node:http";
import path from "node:path";

import { chromium, type Page } from "playwright";

import { GET as getDeploymentFile } from "@/app/deployments/[id]/[[...path]]/route";
import { getDatabase } from "@/db/client";
import type {
  AgentBenchmarkCase,
  BenchmarkArtifactValidation,
  BenchmarkApprovalValidation,
  BenchmarkBrowserScript,
  BenchmarkBrowserStep,
  BenchmarkBrowserStepResult,
  BenchmarkBrowserValidation,
  BenchmarkBuildValidation,
  BenchmarkDeploymentValidation,
  BenchmarkFaultRecord,
  BenchmarkPreviewValidation,
  BenchmarkRuntimeValidation,
  BenchmarkToolCallValidation,
  BenchmarkToolRejectionValidation,
} from "@/server/context-metrics/benchmark-types";
import type { ContextTraceRunResponse } from "@/server/context-trace/context-trace-types";
import { getArtifact } from "@/server/repositories";
import type { Artifact } from "@/shared/types";

export interface RuntimeEvidenceRow {
  id: string;
  task_id: string;
  attempt_id: string;
  child_run_id: string;
  type: string;
  status: string;
  source_id: string;
  subject_id: string;
  payload_json: string;
  created_at: number;
}

export function resolveDeploymentPreviewPath(input: {
  artifactId: string;
  artifactPreviewPath?: string | null;
  evidenceSourceId?: string | null;
  evidencePayload?: Record<string, unknown> | null;
}): string {
  const fromArtifact = input.artifactPreviewPath?.trim();
  if (fromArtifact) return fromArtifact;

  const payload = input.evidencePayload ?? {};
  const fromEvidence =
    asString(payload.previewPath) ||
    asString(payload.localPreviewPath) ||
    asString(payload.deploymentPath);
  if (fromEvidence) return fromEvidence;

  // deploy_artifact uses a deterministic deployment id. This keeps old
  // benchmark databases readable even before previewPath was added to evidence.
  if (input.evidenceSourceId?.startsWith("deploy_artifact_")) {
    return `/deployments/dep_art_${input.artifactId.replace(/^art_/, "")}`;
  }
  return "";
}

export interface RuntimeValidationCollectorOptions {
  reportDir: string;
  apiBase?: string;
  injectedFaults?: BenchmarkFaultRecord[];
}

export async function collectRuntimeValidation(
  benchmarkCase: AgentBenchmarkCase,
  trace: ContextTraceRunResponse,
  options: RuntimeValidationCollectorOptions,
): Promise<BenchmarkRuntimeValidation> {
  const artifacts = collectArtifacts(trace);
  const evidence = readEvidence(trace.conductorRunId);
  const builds = collectBuilds(evidence);
  const toolCalls = collectToolCalls(trace, evidence);
  const toolRejections = collectToolRejections(trace, evidence);
  const approvals = collectApprovals(trace);
  const deploymentServer = options.apiBase ? null : await startDeploymentRouteServer();
  const apiBase = options.apiBase ?? deploymentServer!.baseUrl;
  try {
    const deployments = collectDeployments(trace, artifacts, evidence, apiBase);
    const previews = await probePreviews(deployments);
    const browsers = await runBrowserScripts(
      benchmarkCase.runtime?.browserScripts ?? [],
      deployments,
      options.reportDir,
    );
    return {
      collectedAt: Date.now(),
      artifacts,
      builds,
      deployments,
      previews,
      browsers,
      toolRejections,
      toolCalls,
      injectedFaults: options.injectedFaults ?? [],
      approvals,
    };
  } finally {
    await deploymentServer?.close();
  }
}

function collectToolCalls(
  trace: ContextTraceRunResponse,
  evidence: RuntimeEvidenceRow[],
): BenchmarkToolCallValidation[] {
  const rows = readRunTreeMessageParts(trace.conductorRunId);
  const taskByRunId = readTaskByChildRun(trace);
  const calls = new Map<string, BenchmarkToolCallValidation>();
  let sequence = 0;
  for (const row of rows) {
    const parts = safeArray(row.parts);
    for (const part of parts) {
      if (part.type === "tool_use" && typeof part.callId === "string" && typeof part.toolName === "string") {
        const key = `${row.run_id}:${part.callId}`;
        calls.set(key, {
          runId: row.run_id,
          taskId: taskByRunId.get(row.run_id) ?? null,
          callId: part.callId,
          toolName: part.toolName,
          args: part.args ?? null,
          status: "pending",
          result: null,
          sequence: sequence++,
        });
      }
      if (part.type !== "tool_result" || typeof part.callId !== "string") continue;
      const key = `${row.run_id}:${part.callId}`;
      const call = calls.get(key);
      if (!call) continue;
      call.status = part.isError ? "failed" : "succeeded";
      call.result = part.result ?? null;
    }
  }

  const attemptByRun = readAttemptByChildRun(trace);
  return applyTerminalEvidenceToToolCalls([...calls.values()], evidence)
    .map((call) => ({ ...call, attemptId: attemptByRun.get(call.runId) }))
    .sort((left, right) => left.sequence - right.sequence);
}

export function applyTerminalEvidenceToToolCalls(
  calls: BenchmarkToolCallValidation[],
  evidence: RuntimeEvidenceRow[],
): BenchmarkToolCallValidation[] {
  const terminalByCall = new Map<string, RuntimeEvidenceRow>();
  for (const row of evidence) {
    if (!row.source_id || !row.child_run_id) continue;
    terminalByCall.set(`${row.child_run_id}:${row.source_id}`, row);
  }

  return calls.map((call) => {
    const terminal = terminalByCall.get(`${call.runId}:${call.callId}`);
    if (!terminal) return call;
    const payload = safeObject(terminal.payload_json);
    const exitCode = asNumber(payload.exitCode, terminal.status === "valid" ? 0 : 1);
    const failed = terminal.type === "tool_rejected"
      || terminal.status !== "valid"
      || ((terminal.type === "command_executed" || terminal.type === "test_executed") && exitCode !== 0);
    return {
      ...call,
      status: failed ? "failed" : "succeeded",
      result: payload,
    };
  });
}

function readRunTreeMessageParts(
  conductorRunId: string,
): Array<{ run_id: string; parts: string }> {
  return getDatabase().prepare(`
    WITH RECURSIVE run_tree(id) AS (
      SELECT ?
      UNION ALL
      SELECT child.id
      FROM agent_runs child
      JOIN run_tree parent ON child.parent_run_id = parent.id
    )
    SELECT messages.run_id, messages.parts
    FROM messages
    JOIN run_tree ON run_tree.id = messages.run_id
    ORDER BY messages.created_at, messages.id
  `).all(conductorRunId) as Array<{ run_id: string; parts: string }>;
}

function collectApprovals(trace: ContextTraceRunResponse): BenchmarkApprovalValidation[] {
  const taskByRunId = readTaskByChildRun(trace);
  const rows = getDatabase().prepare(`
    WITH RECURSIVE run_tree(id) AS (
      SELECT ?
      UNION ALL
      SELECT child.id
      FROM agent_runs child
      JOIN run_tree parent ON child.parent_run_id = parent.id
    )
    SELECT approvals.id, approvals.run_id, approvals.approval_type, approvals.status, approvals.payload_json
    FROM pending_approvals approvals
    JOIN run_tree ON run_tree.id = approvals.run_id
    ORDER BY approvals.created_at, approvals.id
  `).all(trace.conductorRunId) as Array<{
    id: string;
    run_id: string;
    approval_type: BenchmarkApprovalValidation["approvalType"];
    status: string;
    payload_json: string;
  }>;
  return rows.map((row) => ({
    id: row.id,
    runId: row.run_id,
    taskId: taskByRunId.get(row.run_id) ?? null,
    approvalType: row.approval_type,
    status: row.status,
    payload: row.payload_json,
  }));
}

function collectToolRejections(
  trace: ContextTraceRunResponse,
  evidence: RuntimeEvidenceRow[],
): BenchmarkToolRejectionValidation[] {
  const taskByRunId = readTaskByChildRun(trace);
  const byCall = new Map<string, BenchmarkToolRejectionValidation>();
  for (const row of evidence) {
    if (row.type !== "tool_rejected") continue;
    const payload = safeObject(row.payload_json);
    const toolName = asString(payload.toolName) || row.subject_id;
    const callId = row.source_id;
    const category = normalizeRejectionCategory(payload.category);
    const conflictingSuccessEvidenceIds = evidence
      .filter((candidate) =>
        candidate.source_id === callId
        && candidate.status === "valid"
        && candidate.type !== "tool_rejected"
        && isSideEffectEvidence(candidate.type)
      )
      .map((candidate) => candidate.id);
    byCall.set(`${row.child_run_id}:${callId}`, {
      runId: row.child_run_id,
      taskId: row.task_id || taskByRunId.get(row.child_run_id) || null,
      attemptId: row.attempt_id,
      callId,
      toolName,
      category,
      code: asString(payload.code) || undefined,
      reason: asString(payload.reason) || "Tool execution was rejected.",
      conflictingSuccessEvidenceIds,
    });
  }

  // Compatibility fallback for historical runs created before tool_rejected
  // became canonical task evidence.
  const rows = readRunTreeMessageParts(trace.conductorRunId);
  const calls = new Map<string, { runId: string; toolName: string }>();
  for (const row of rows) {
    const parts = safeArray(row.parts);
    for (const part of parts) {
      if (part.type === "tool_use" && typeof part.callId === "string" && typeof part.toolName === "string") {
        calls.set(part.callId, { runId: row.run_id, toolName: part.toolName });
      }
      if (part.type !== "tool_result" || !part.isError || typeof part.callId !== "string") continue;
      const call = calls.get(part.callId);
      if (!call) continue;
      const key = `${call.runId}:${part.callId}`;
      if (byCall.has(key)) continue;
      const reason = stringifyToolResult(part.result);
      byCall.set(key, {
        runId: call.runId,
        taskId: taskByRunId.get(call.runId) ?? null,
        callId: part.callId,
        toolName: call.toolName,
        category: classifyToolRejection(reason),
        reason,
      });
    }
  }
  return [...byCall.values()];
}

function normalizeRejectionCategory(
  value: unknown,
): BenchmarkToolRejectionValidation["category"] {
  if (value === "security_policy" || value === "approval_rejected") return value;
  return "tool_error";
}

function isSideEffectEvidence(type: string): boolean {
  return type === "command_executed"
    || type === "test_executed"
    || type === "file_written"
    || type === "artifact_created"
    || type === "deployment_created";
}

function readTaskByChildRun(trace: ContextTraceRunResponse): Map<string, string> {
  const taskByRunId = new Map<string, string>();
  const taskByAttemptId = new Map<string, string>();
  for (const task of trace.tasks) {
    for (const attempt of task.attempts) taskByAttemptId.set(attempt.attemptId, task.taskId);
  }
  const rows = getDatabase()
    .prepare("SELECT id, child_run_id FROM task_attempts WHERE conductor_run_id = ?")
    .all(trace.conductorRunId) as Array<{ id: string; child_run_id: string | null }>;
  for (const row of rows) {
    const taskId = taskByAttemptId.get(row.id);
    if (row.child_run_id && taskId) taskByRunId.set(row.child_run_id, taskId);
  }
  return taskByRunId;
}

function readAttemptByChildRun(trace: ContextTraceRunResponse): Map<string, string> {
  const attemptByRun = new Map<string, string>();
  const rows = getDatabase()
    .prepare("SELECT id, child_run_id FROM task_attempts WHERE conductor_run_id = ?")
    .all(trace.conductorRunId) as Array<{ id: string; child_run_id: string | null }>;
  for (const row of rows) {
    if (row.child_run_id) attemptByRun.set(row.child_run_id, row.id);
  }
  return attemptByRun;
}

function safeArray(value: string): Array<Record<string, unknown>> {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object") : [];
  } catch {
    return [];
  }
}

function stringifyToolResult(result: unknown): string {
  if (typeof result === "string") return result;
  try {
    return JSON.stringify(result);
  } catch {
    return String(result);
  }
}

function classifyToolRejection(reason: string): BenchmarkToolRejectionValidation["category"] {
  if (/reject|declin|cancel|拒绝|取消/i.test(reason)) return "approval_rejected";
  if (/security policy|verification-only|source mutation|outside.*workspace|escapes?.*workspace|path traversal|blocked|越界|安全策略/i.test(reason)) {
    return "security_policy";
  }
  return "tool_error";
}

function collectArtifacts(trace: ContextTraceRunResponse): BenchmarkArtifactValidation[] {
  return trace.tasks.flatMap((task) => task.producedBindings.map((binding) => {
    const artifact = getArtifact(binding.artifactId);
    return validateArtifact(task.taskId, binding.outputKey, binding.artifactId, binding.artifactType, binding.artifactTitle, artifact);
  }));
}

function validateArtifact(
  taskId: string,
  outputKey: string,
  artifactId: string,
  artifactType: string,
  title: string,
  artifact: Artifact | null,
): BenchmarkArtifactValidation {
  const errors: string[] = [];
  if (!artifact) errors.push("artifact row is missing");
  if (artifact && artifact.type !== artifactType) errors.push(`persisted type ${artifact.type} does not match binding type ${artifactType}`);
  const serialized = artifact ? JSON.stringify(artifact.content) : "";
  const files = artifact?.content.type === "web_app" ? Object.keys(artifact.content.files).sort() : [];
  if (artifact?.content.type === "document" && artifact.content.content.trim().length === 0) errors.push("document body is empty");
  if (artifact?.content.type === "web_app") {
    if (files.length === 0) errors.push("web app contains no files");
    if (!artifact.content.files[artifact.content.entry]) errors.push(`entry file ${artifact.content.entry} is missing`);
    const entry = artifact.content.files[artifact.content.entry] ?? "";
    if (!/<(?:html|body|div|main|script)\b/i.test(entry)) errors.push("entry file does not contain renderable markup");
  }
  return {
    taskId,
    outputKey,
    artifactId,
    artifactType,
    title,
    contentBytes: Buffer.byteLength(serialized, "utf-8"),
    contentText: serialized,
    files,
    valid: errors.length === 0,
    errors,
  };
}

function readEvidence(conductorRunId: string): RuntimeEvidenceRow[] {
  return getDatabase().prepare(`
    SELECT id, task_id, attempt_id, child_run_id, type, status, source_id,
           subject_id, payload_json, created_at
    FROM task_evidence
    WHERE conductor_run_id = ?
    ORDER BY created_at ASC, id ASC
  `).all(conductorRunId) as RuntimeEvidenceRow[];
}

export function selectLatestTerminalEvidence(
  rows: RuntimeEvidenceRow[],
  includedTypes: ReadonlySet<string>,
): RuntimeEvidenceRow[] {
  const terminalByCall = new Map<string, RuntimeEvidenceRow>();
  const ordered = [...rows].sort((left, right) =>
    left.created_at - right.created_at || left.id.localeCompare(right.id)
  );
  for (const row of ordered) {
    if (!includedTypes.has(row.type)) continue;
    terminalByCall.set(`${row.child_run_id}:${row.source_id}`, row);
  }
  return [...terminalByCall.values()];
}

export function selectLatestValidDeploymentEvidence(
  candidates: RuntimeEvidenceRow[],
  artifactId: string,
): RuntimeEvidenceRow | undefined {
  const ordered = [...candidates].sort((left, right) =>
    right.created_at - left.created_at || right.id.localeCompare(left.id)
  );
  return ordered.find((row) => {
    if (row.status !== "valid") return false;
    const payload = safeObject(row.payload_json);
    const previewPath = resolveDeploymentPreviewPath({
      artifactId,
      artifactPreviewPath: null,
      evidenceSourceId: row.source_id,
      evidencePayload: payload,
    });
    return asString(payload.deploymentStatus) !== "failed" && Boolean(previewPath);
  });
}

function collectBuilds(rows: RuntimeEvidenceRow[]): BenchmarkBuildValidation[] {
  return selectLatestTerminalEvidence(
    rows,
    new Set(["command_executed", "test_executed"]),
  ).map((row) => {
      const payload = safeObject(row.payload_json);
      return {
        taskId: row.task_id,
        attemptId: row.attempt_id,
        evidenceId: row.id,
        toolCallId: row.source_id,
        command: asString(payload.command) || row.subject_id,
        exitCode: asNumber(payload.exitCode, row.status === "valid" ? 0 : 1),
        timedOut: payload.timedOut === true,
        status: row.status,
        outputExcerpt: asString(payload.outputExcerpt),
      };
    });
}

function collectDeployments(
  trace: ContextTraceRunResponse,
  artifacts: BenchmarkArtifactValidation[],
  evidence: RuntimeEvidenceRow[],
  apiBase: string,
): BenchmarkDeploymentValidation[] {
  const artifactMap = new Map(artifacts.map((item) => [item.artifactId, item]));
  return trace.tasks.flatMap((task) => task.producedBindings.flatMap((binding) => {
    if (binding.artifactType !== "web_app") return [];
    const artifact = getArtifact(binding.artifactId);
    const candidates = evidence.filter((row) => {
      if (row.task_id !== task.taskId || row.type !== "deployment_created") return false;
      const payload = safeObject(row.payload_json);
      return row.subject_id === binding.outputKey || payload.artifactId === binding.artifactId;
    });
    const deploymentEvidence = selectLatestValidDeploymentEvidence(
      candidates,
      binding.artifactId,
    );
    const deploymentPayload = deploymentEvidence ? safeObject(deploymentEvidence.payload_json) : {};
    const previewPath = resolveDeploymentPreviewPath({
      artifactId: binding.artifactId,
      artifactPreviewPath: artifact?.content.type === "web_app"
        ? artifact.content.deploymentPreviewPath
        : null,
      evidenceSourceId: deploymentEvidence?.source_id,
      evidencePayload: deploymentPayload
    });
    const deploymentStatus = asString(deploymentPayload.deploymentStatus);
    return [{
      taskId: task.taskId,
      attemptId: deploymentEvidence?.attempt_id,
      outputKey: binding.outputKey,
      artifactId: binding.artifactId,
      evidenceId: deploymentEvidence?.id ?? null,
      toolCallId: deploymentEvidence?.source_id ?? null,
      previewPath,
      previewUrl: previewPath ? new URL(previewPath, ensureTrailingSlash(apiBase)).toString() : "",
      ready: Boolean(
        previewPath &&
        deploymentEvidence &&
        deploymentStatus !== "failed" &&
        artifactMap.get(binding.artifactId)?.valid
      ),
      supersededEvidenceIds: candidates
        .filter((candidate) => candidate.id !== deploymentEvidence?.id)
        .map((candidate) => candidate.id),
    }];
  }));
}

async function probePreviews(deployments: BenchmarkDeploymentValidation[]): Promise<BenchmarkPreviewValidation[]> {
  return Promise.all(deployments.map(async (deployment) => {
    if (!deployment.ready || !deployment.previewUrl) {
      return {
        outputKey: deployment.outputKey,
        artifactId: deployment.artifactId,
        previewUrl: deployment.previewUrl,
        status: null,
        bodyBytes: 0,
        contentType: null,
        error: "Deployment is not backed by valid evidence, artifact content, and a preview path.",
      };
    }
    try {
      const response = await fetch(deployment.previewUrl, { signal: AbortSignal.timeout(15_000) });
      const body = await response.arrayBuffer();
      return {
        outputKey: deployment.outputKey,
        artifactId: deployment.artifactId,
        previewUrl: deployment.previewUrl,
        status: response.status,
        bodyBytes: body.byteLength,
        contentType: response.headers.get("content-type"),
        error: response.ok ? null : `HTTP ${response.status}`,
      };
    } catch (error) {
      return {
        outputKey: deployment.outputKey,
        artifactId: deployment.artifactId,
        previewUrl: deployment.previewUrl,
        status: null,
        bodyBytes: 0,
        contentType: null,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }));
}

/**
 * Launch a browser for the behavioural assertions.
 *
 * Playwright's bundled Chromium is a separate ~150MB download, and when it is
 * missing `chromium.launch()` throws — which, because this call sits outside the
 * try below, turned the whole trial into an error rather than a blocked check.
 * Prefer the bundled browser, then fall back to an installed Chrome, so the five
 * fixtures with browser scripts stay runnable without that download.
 * `AGENTMELD_BROWSER_CHANNEL` overrides the choice (e.g. `chrome`, `msedge`).
 */
async function launchBrowser(): Promise<Awaited<ReturnType<typeof chromium.launch>>> {
  const channel = process.env.AGENTMELD_BROWSER_CHANNEL?.trim();
  if (channel) return chromium.launch({ headless: true, channel });

  try {
    return await chromium.launch({ headless: true });
  } catch (bundledError) {
    try {
      return await chromium.launch({ headless: true, channel: "chrome" });
    } catch (channelError) {
      // Keep both messages: the bundled-browser one is the actionable hint
      // ("run npx playwright install chromium"), the channel one explains why the
      // fallback could not rescue the run.
      const describe = (error: unknown) => (error instanceof Error ? error.message : String(error));
      throw new Error(
        `${describe(bundledError)} | fallback to channel "chrome" also failed: ${describe(channelError)}`
      );
    }
  }
}

async function runBrowserScripts(
  scripts: BenchmarkBrowserScript[],
  deployments: BenchmarkDeploymentValidation[],
  reportDir: string,
): Promise<BenchmarkBrowserValidation[]> {
  if (scripts.length === 0) return [];

  let browser: Awaited<ReturnType<typeof chromium.launch>>;
  try {
    browser = await launchBrowser();
  } catch (error) {
    // No usable browser at all: report the assertion as blocked instead of
    // letting the launch throw and turn the entire trial into an error.
    const reason = `No browser available for the browser assertions (${
      error instanceof Error ? error.message : String(error)
    }). Install one with "npx playwright install chromium" or set AGENTMELD_BROWSER_CHANNEL.`;
    return scripts.map((script) => blockedBrowserResult(script, reason));
  }

  try {
    const results: BenchmarkBrowserValidation[] = [];
    for (const script of scripts) {
      const deployment = deployments.find((candidate) => candidate.ready && (!script.outputKey || candidate.outputKey === script.outputKey));
      if (!deployment) {
        results.push(blockedBrowserResult(script, "No ready deployment matched the browser script."));
        continue;
      }
      results.push(await runBrowserScript(browser, script, deployment, reportDir));
    }
    return results;
  } finally {
    await browser.close();
  }
}

async function runBrowserScript(
  browser: Awaited<ReturnType<typeof chromium.launch>>,
  script: BenchmarkBrowserScript,
  deployment: BenchmarkDeploymentValidation,
  reportDir: string,
): Promise<BenchmarkBrowserValidation> {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  const failedRequests: string[] = [];
  const blockingFailedRequests: string[] = [];
  page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("requestfailed", (request) => {
    const detail = `${request.method()} ${request.url()}: ${request.failure()?.errorText ?? "failed"}`;
    failedRequests.push(detail);
    if (isBlockingBrowserRequest(request.url(), deployment.previewUrl)) {
      blockingFailedRequests.push(detail);
    }
  });
  page.on("response", (response) => {
    if (response.status() < 400) return;
    const detail = `${response.status()} ${response.url()}`;
    failedRequests.push(detail);
    if (isBlockingBrowserRequest(response.url(), deployment.previewUrl)) {
      blockingFailedRequests.push(detail);
    }
  });
  const steps: BenchmarkBrowserStepResult[] = [];
  let error: string | null = null;
  let baseline = "";
  const screenshotPath = path.join(reportDir, `browser-${safeFileName(script.id)}.png`);
  try {
    if (script.initialTimeMs !== undefined) {
      await page.clock.install({ time: script.initialTimeMs });
    }
    await page.goto(deployment.previewUrl, { waitUntil: "networkidle", timeout: script.timeoutMs ?? 30_000 });
    baseline = await domFingerprint(page);
    for (let index = 0; index < script.steps.length; index++) {
      const step = script.steps[index];
      try {
        await executeStep(page, step, baseline);
        steps.push({ index, action: step.action, status: "passed", detail: describeStep(step) });
        if (step.action === "assert_dom_changed") baseline = await domFingerprint(page);
      } catch (stepError) {
        const detail = stepError instanceof Error ? stepError.message : String(stepError);
        steps.push({ index, action: step.action, status: "failed", detail });
        error = `Step ${index + 1} (${step.action}) failed: ${detail}`;
        break;
      }
    }
  } catch (runError) {
    error = runError instanceof Error ? runError.message : String(runError);
  } finally {
    fs.mkdirSync(reportDir, { recursive: true });
    await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => undefined);
    await page.close();
  }
  const blockingConsoleErrors = consoleErrors.filter((message) =>
    !/^Failed to load resource:/i.test(message.trim())
  );
  const status = !error
    && blockingConsoleErrors.length === 0
    && pageErrors.length === 0
    && blockingFailedRequests.length === 0
    ? "passed" as const
    : "failed" as const;
  return {
    scriptId: script.id,
    outputKey: deployment.outputKey,
    previewUrl: deployment.previewUrl,
    status,
    steps,
    consoleErrors,
    pageErrors,
    failedRequests: [...new Set(failedRequests)],
    screenshotPath: fs.existsSync(screenshotPath) ? path.resolve(screenshotPath) : null,
    error,
  };
}

export function isBlockingBrowserRequest(requestUrl: string, previewUrl: string): boolean {
  try {
    return new URL(requestUrl).origin === new URL(previewUrl).origin;
  } catch {
    return true;
  }
}

async function executeStep(page: Page, step: BenchmarkBrowserStep, baseline: string): Promise<void> {
  switch (step.action) {
    case "fill": {
      const locator = await firstVisibleLocator(page, step.selector);
      await locator.fill(step.value);
      return;
    }
    case "click": {
      const locator = await firstVisibleLocator(page, step.selector);
      await locator.click();
      return;
    }
    case "press": {
      const locator = await firstVisibleLocator(page, step.selector);
      await locator.press(step.key);
      return;
    }
    case "check": {
      const locator = await firstVisibleLocator(page, step.selector);
      await locator.check();
      return;
    }
    case "select_option": {
      const locator = await firstVisibleLocator(page, step.selector);
      await locator.selectOption({ index: step.index });
      return;
    }
    case "wait":
      await page.waitForTimeout(step.timeoutMs);
      return;
    case "reload":
      await page.reload({ waitUntil: "networkidle" });
      return;
    case "navigate":
      await page.goto(new URL(step.path, page.url()).toString(), { waitUntil: "networkidle" });
      return;
    case "advance_clock":
      await page.clock.fastForward(step.timeoutMs);
      return;
    case "assert_storage": {
      const deadline = Date.now() + (step.timeoutMs ?? 3_000);
      let failure = "localStorage assertion did not complete.";
      while (Date.now() <= deadline) {
        const snapshot = await page.evaluate(() => Object.fromEntries(Object.entries(localStorage)));
        failure = storageAssertionFailure(snapshot, step);
        if (!failure) return;
        await page.waitForTimeout(100);
      }
      throw new Error(failure);
    }
    case "assert_text":
      await page.getByText(step.text, { exact: false }).first().waitFor({ state: "visible" });
      return;
    case "assert_visible": {
      const locator = await firstVisibleLocator(page, step.selector);
      await locator.waitFor({ state: "visible" });
      return;
    }
    case "assert_dom_changed": {
      const current = await domFingerprint(page);
      if (current === baseline) throw new Error("DOM text and form values did not change after interaction.");
      return;
    }
  }
}

async function firstVisibleLocator(page: Page, selectorList: string) {
  const selectors = splitSelectorFallbacks(selectorList);
  const deadline = Date.now() + 5_000;
  do {
    for (const selector of selectors) {
      const locator = page.locator(selector).first();
      if (await locator.isVisible().catch(() => false)) return locator;
    }
    await page.waitForTimeout(50);
  } while (Date.now() < deadline);

  // Keep Playwright's normal timeout and diagnostics for the first fallback
  // when none of the alternatives becomes visible during the short probe.
  if (selectors.length > 0) {
    return page.locator(selectors[0]).first();
  }
  return page.locator(selectorList).first();
}

export function splitSelectorFallbacks(selectorList: string): string[] {
  const selectors: string[] = [];
  let current = "";
  let quote = "";
  let squareDepth = 0;
  let roundDepth = 0;
  for (const char of selectorList) {
    if (quote) {
      current += char;
      if (char === quote) quote = "";
      continue;
    }
    if (char === "'" || char === "\"") {
      quote = char;
      current += char;
      continue;
    }
    if (char === "[") squareDepth++;
    else if (char === "]") squareDepth = Math.max(0, squareDepth - 1);
    else if (char === "(") roundDepth++;
    else if (char === ")") roundDepth = Math.max(0, roundDepth - 1);
    if (char === "," && squareDepth === 0 && roundDepth === 0) {
      if (current.trim()) selectors.push(current.trim());
      current = "";
      continue;
    }
    current += char;
  }
  if (current.trim()) selectors.push(current.trim());
  return selectors;
}

function storageAssertionFailure(
  entries: Record<string, string>,
  step: Extract<BenchmarkBrowserStep, { action: "assert_storage" }>,
): string {
  const count = Object.keys(entries).length;
  if (step.minEntries !== undefined && count < step.minEntries) {
    return `localStorage has ${count} entries; expected at least ${step.minEntries}.`;
  }
  if (!step.key) return "";
  const value = entries[step.key];
  if (value === undefined) return `localStorage key "${step.key}" is missing.`;
  if (step.valuePattern && !new RegExp(step.valuePattern, "i").test(value)) {
    return `localStorage key "${step.key}" does not match ${step.valuePattern}.`;
  }
  return "";
}

function blockedBrowserResult(script: BenchmarkBrowserScript, error: string): BenchmarkBrowserValidation {
  return {
    scriptId: script.id,
    outputKey: script.outputKey ?? "web_app",
    previewUrl: "",
    status: "blocked",
    steps: [],
    consoleErrors: [],
    pageErrors: [],
    failedRequests: [],
    screenshotPath: null,
    error,
  };
}

async function domFingerprint(page: Page): Promise<string> {
  return page.evaluate(() => JSON.stringify({
    text: document.body?.innerText ?? "",
    controls: Array.from(document.querySelectorAll("input, textarea, select")).map((element) => {
      const control = element as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
      return { value: control.value, checked: "checked" in control ? control.checked : undefined };
    }),
  }));
}

function describeStep(step: BenchmarkBrowserStep): string {
  if ("selector" in step) return `${step.action} ${step.selector}`;
  if (step.action === "assert_text") return `assert text ${step.text}`;
  if (step.action === "wait") return `wait ${step.timeoutMs}ms`;
  return step.action;
}

async function startDeploymentRouteServer(): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      const match = url.pathname.match(/^\/deployments\/([^/]+)(?:\/(.*))?$/);
      if (!match) {
        response.writeHead(404).end("Not found.");
        return;
      }
      const deploymentId = decodeURIComponent(match[1]);
      const parts = match[2] ? match[2].split("/").filter(Boolean).map(decodeURIComponent) : undefined;
      const routeResponse = await getDeploymentFile(new Request(url), {
        params: Promise.resolve({ id: deploymentId, path: parts }),
      });
      response.writeHead(routeResponse.status, Object.fromEntries(routeResponse.headers.entries()));
      response.end(Buffer.from(await routeResponse.arrayBuffer()));
    } catch (error) {
      response.writeHead(500).end(error instanceof Error ? error.message : String(error));
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Benchmark deployment server did not bind a TCP port.");
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

function safeObject(raw: string): Record<string, unknown> {
  try {
    const value = JSON.parse(raw) as unknown;
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}

function safeFileName(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-|-$/g, "") || "script";
}
