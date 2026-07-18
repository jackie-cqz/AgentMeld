// ---------------------------------------------------------------------------
// P3: Context Quality Metrics Service — raw metrics + derived rates
// ---------------------------------------------------------------------------

import { getDatabase } from "@/db/client";
import type {
  ContextQualityRunMetrics,
  ContextQualityDerivedRates,
  ContextQualityReport,
} from "@/server/context-metrics/context-metrics-types";

// ── Public ──────────────────────────────────────────────────────────────────

/** Compute the full quality report for a conductor run */
export function computeRunMetrics(runId: string): ContextQualityReport | { error: string; status: number } {
  const raw = collectRawMetrics(runId);
  if (!raw) return { error: "No task attempts found for this run.", status: 404 };

  const derived = computeDerivedRates(raw);
  const sources = collectMetricSources(runId);
  return { runId, raw, derived, sources };
}

// ── Raw metrics collection ──────────────────────────────────────────────────

function collectRawMetrics(conductorRunId: string): ContextQualityRunMetrics | null {
  const db = getDatabase();
  const attempts = db
    .prepare(`
      SELECT id, conversation_id, task_id, attempt, execution_status, verification_status, child_run_id, context_snapshot_id
      FROM task_attempts
      WHERE conductor_run_id = ? AND task_id != 'conductor'
      ORDER BY task_id, attempt
    `)
    .all(conductorRunId) as AttemptMetricRow[];

  if (attempts.length === 0) return null;

  const latestAttempts = new Map<string, AttemptMetricRow>();
  for (const attempt of attempts) latestAttempts.set(attempt.task_id, attempt);
  const latest = [...latestAttempts.values()];
  const taskCount = latest.length;
  const attemptCount = attempts.length;
  const completedTaskCount = latest.filter((attempt) =>
    attempt.execution_status === "reported_complete" && attempt.verification_status !== "rejected"
  ).length;
  const failedTaskCount = latest.filter((attempt) =>
    attempt.execution_status === "failed" || attempt.verification_status === "rejected"
  ).length;
  const verifiedTaskCount = latest.filter((attempt) => attempt.verification_status === "verified").length;
  const rejectedTaskCount = latest.filter((attempt) => attempt.verification_status === "rejected").length;
  const needsReviewTaskCount = latest.filter((attempt) => attempt.verification_status === "needs_review").length;

  const planRow = db
    .prepare("SELECT id, plan_json FROM conductor_plans WHERE conductor_run_id = ? ORDER BY revision DESC LIMIT 1")
    .get(conductorRunId) as { id: string; plan_json: string } | undefined;
  const allBindings = planRow
    ? db.prepare(`
        SELECT producer_task_id, actual_producer_task_id, output_key, artifact_id
        FROM conductor_output_bindings
        WHERE conductor_run_id = ? AND plan_id = ? AND superseded_at IS NULL
      `).all(conductorRunId, planRow.id) as OutputBindingRow[]
    : [];
  const verifiedOutputBindingCount = allBindings.length;
  const unverifiedOutputPropagationCount = allBindings.filter((binding) =>
    latestAttempts.get(binding.actual_producer_task_id ?? binding.producer_task_id)?.verification_status !== "verified"
  ).length;

  let verifiedInputCount = 0;
  let missingRequiredInputCount = 0;
  let upstreamInputReadCount = 0;
  let upstreamInputUnreadCount = 0;
  const planTasks = parsePlanTasks(planRow?.plan_json);
  const planTaskById = new Map(planTasks.map((task) => [task.id, task]));

  for (const task of planTasks) {
    const specs = new Map<string, { fromTaskId: string; outputId: string }>();
    for (const input of task.inputs ?? []) {
      if (input.required === false) continue;
      specs.set(`${input.fromTaskId}.${input.outputId}`, input);
    }
    for (const dependencyId of task.dependsOn ?? []) {
      const dependency = planTaskById.get(dependencyId);
      for (const output of dependency?.expectedOutputs ?? []) {
        if (output.required === false) continue;
        specs.set(`${dependencyId}.${output.id}`, { fromTaskId: dependencyId, outputId: output.id });
      }
    }

    const attempt = latestAttempts.get(task.id);
    const readArtifactIds = attempt ? readArtifactsForAttempt(attempt.id) : new Set<string>();
    for (const spec of specs.values()) {
      const binding = allBindings.find((item) =>
        item.producer_task_id === spec.fromTaskId && item.output_key === spec.outputId
      );
      if (!binding) {
        missingRequiredInputCount++;
        continue;
      }
      verifiedInputCount++;
      if (readArtifactIds.has(binding.artifact_id)) upstreamInputReadCount++;
      else upstreamInputUnreadCount++;
    }
  }

  let contextIncludedItemCount = 0;
  let contextOmittedItemCount = 0;
  let contextOmittedByBudgetCount = 0;
  let staleRejectedCount = 0;
  let staleFactLeakageCount = 0;
  let unverifiedRejectedCount = 0;
  let unrelatedRejectedCount = 0;
  const contextOmittedReasonCounts: Record<string, number> = {};

  for (const attempt of attempts) {
    if (!attempt.context_snapshot_id) continue;
    const snapshot = db
      .prepare("SELECT manifest_json FROM task_context_snapshots WHERE id = ?")
      .get(attempt.context_snapshot_id) as { manifest_json: string } | undefined;
    for (const item of parseManifest(snapshot?.manifest_json)) {
      if (item.included) {
        contextIncludedItemCount++;
        if (item.category === "fact" && item.sourceId && isStaleFact(attempt.conversation_id, item.sourceId)) {
          staleFactLeakageCount++;
        }
        continue;
      }
      contextOmittedItemCount++;
      const reason = item.omittedReason ?? "unspecified";
      contextOmittedReasonCounts[reason] = (contextOmittedReasonCounts[reason] ?? 0) + 1;
      if (reason === "budget") contextOmittedByBudgetCount++;
      if (reason === "stale") staleRejectedCount++;
      if (reason === "unverified") unverifiedRejectedCount++;
      if (reason === "unrelated") unrelatedRejectedCount++;
    }
  }

  const evidence = db
    .prepare(`
      SELECT type, status, subject_id
      FROM task_evidence
      WHERE conductor_run_id = ?
    `)
    .all(conductorRunId) as Array<{ type: string; status: string; subject_id: string }>;
  const evidenceCount = evidence.length;
  const artifactCreatedCount = new Set(
    evidence.filter((item) => item.type === "artifact_created" && item.status === "valid").map((item) => item.subject_id)
  ).size;
  const deploymentReadyCount = new Set(
    evidence.filter((item) => item.type === "deployment_created" && item.status === "valid").map((item) => item.subject_id)
  ).size;
  const invalidOutputEvidenceCount = evidence.filter((item) =>
    item.status !== "valid" && (item.type === "artifact_created" || item.type === "deployment_created")
  ).length;
  const rejectedOutputClaimCount = invalidOutputEvidenceCount + rejectedTaskCount;

  const webAppOutputCount = planRow
    ? (db.prepare(`
        SELECT COUNT(DISTINCT binding.artifact_id) AS count
        FROM conductor_output_bindings AS binding
        JOIN artifacts AS artifact ON artifact.id = binding.artifact_id
        WHERE binding.conductor_run_id = ? AND binding.plan_id = ?
          AND binding.superseded_at IS NULL
          AND artifact.type = 'web_app'
      `).get(conductorRunId, planRow.id) as { count: number }).count
    : 0;

  const runIds = readRunTreeIds(conductorRunId);
  const toolMetrics = readToolMetrics(runIds);
  const approvalRequestCount = countApprovals(runIds);
  const usage = readUsageMetrics(runIds);

  return {
    runId: conductorRunId,
    taskCount,
    attemptCount,
    completedTaskCount,
    failedTaskCount,
    verifiedInputCount,
    missingRequiredInputCount,
    upstreamInputReadCount,
    upstreamInputUnreadCount,
    contextIncludedItemCount,
    contextOmittedItemCount,
    contextOmittedByBudgetCount,
    staleRejectedCount,
    staleFactLeakageCount,
    unverifiedRejectedCount,
    unrelatedRejectedCount,
    contextOmittedReasonCounts,
    evidenceCount,
    toolCallCount: toolMetrics.toolCallCount,
    failedToolCallCount: toolMetrics.failedToolCallCount,
    verifiedOutputBindingCount,
    rejectedOutputClaimCount,
    unverifiedOutputPropagationCount,
    approvalRequestCount,
    jsonRepairCount: toolMetrics.jsonRepairCount,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    modelRunCount: usage.modelRunCount,
    verifiedTaskCount,
    rejectedTaskCount,
    needsReviewTaskCount,
    artifactCreatedCount,
    webAppOutputCount,
    deploymentReadyCount,
  };
}

interface AttemptMetricRow {
  id: string;
  conversation_id: string;
  task_id: string;
  attempt: number;
  execution_status: string;
  verification_status: string;
  child_run_id: string | null;
  context_snapshot_id: string | null;
}

interface OutputBindingRow {
  producer_task_id: string;
  actual_producer_task_id: string | null;
  output_key: string;
  artifact_id: string;
}

interface PlanMetricTask {
  id: string;
  dependsOn?: string[];
  inputs?: Array<{ fromTaskId: string; outputId: string; required?: boolean }>;
  expectedOutputs?: Array<{ id: string; type: string; required?: boolean }>;
}

function parsePlanTasks(value: string | undefined): PlanMetricTask[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed as PlanMetricTask[] : [];
  } catch {
    return [];
  }
}

function parseManifest(value: string | undefined): Array<{ included: boolean; omittedReason?: string | null; category?: string; sourceId?: string }> {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed as Array<{ included: boolean; omittedReason?: string | null; category?: string; sourceId?: string }> : [];
  } catch {
    return [];
  }
}

function isStaleFact(conversationId: string, canonicalKey: string): boolean {
  const rows = getDatabase().prepare(`
    SELECT status
    FROM conversation_facts
    WHERE conversation_id = ? AND canonical_key = ?
    ORDER BY updated_at DESC
  `).all(conversationId, canonicalKey) as Array<{ status: string }>;
  return rows.length > 0 && !rows.some((row) => row.status === "active");
}

function readArtifactsForAttempt(attemptId: string): Set<string> {
  const rows = getDatabase()
    .prepare(`
      SELECT subject_id, payload_json
      FROM task_evidence
      WHERE attempt_id = ? AND type = 'artifact_read' AND status = 'valid'
    `)
    .all(attemptId) as Array<{ subject_id: string; payload_json: string }>;
  const artifactIds = new Set<string>();
  for (const row of rows) {
    if (row.subject_id) artifactIds.add(row.subject_id);
    try {
      const payload = JSON.parse(row.payload_json) as { artifactId?: unknown };
      if (typeof payload.artifactId === "string") artifactIds.add(payload.artifactId);
    } catch { /* malformed evidence is ignored */ }
  }
  return artifactIds;
}

function readRunTreeIds(conductorRunId: string): string[] {
  const rows = getDatabase().prepare(`
    WITH RECURSIVE run_tree(id) AS (
      SELECT id FROM agent_runs WHERE id = ?
      UNION
      SELECT child.id
      FROM agent_runs AS child
      JOIN run_tree AS parent ON child.parent_run_id = parent.id
    )
    SELECT id FROM run_tree
  `).all(conductorRunId) as Array<{ id: string }>;
  return rows.map((row) => row.id);
}

function placeholders(values: string[]): string {
  return values.map(() => "?").join(", ");
}

function readToolMetrics(runIds: string[]): {
  toolCallCount: number;
  failedToolCallCount: number;
  jsonRepairCount: number;
} {
  if (runIds.length === 0) return { toolCallCount: 0, failedToolCallCount: 0, jsonRepairCount: 0 };
  const rows = getDatabase()
    .prepare(`SELECT parts FROM messages WHERE run_id IN (${placeholders(runIds)})`)
    .all(...runIds) as Array<{ parts: string }>;
  const calls = new Set<string>();
  const failures = new Set<string>();
  const repairs = new Set<string>();
  for (const row of rows) {
    let parts: Array<{
      type?: string;
      callId?: string;
      isError?: boolean;
      argumentRepair?: { applied?: boolean };
    }> = [];
    try {
      const parsed = typeof row.parts === "string" ? JSON.parse(row.parts) : row.parts;
      if (Array.isArray(parsed)) parts = parsed;
    } catch { /* malformed historical message parts are ignored */ }
    for (const part of parts) {
      if (!part.callId) continue;
      if (part.type === "tool_use") {
        calls.add(part.callId);
        if (part.argumentRepair?.applied) repairs.add(part.callId);
      }
      if (part.type === "tool_result" && part.isError) failures.add(part.callId);
    }
  }
  return {
    toolCallCount: calls.size,
    failedToolCallCount: [...failures].filter((callId) => calls.has(callId)).length,
    jsonRepairCount: [...repairs].filter((callId) => calls.has(callId)).length,
  };
}

function countApprovals(runIds: string[]): number {
  if (runIds.length === 0) return 0;
  const row = getDatabase()
    .prepare(`SELECT COUNT(*) AS count FROM pending_approvals WHERE run_id IN (${placeholders(runIds)})`)
    .get(...runIds) as { count: number };
  return row.count;
}

function readUsageMetrics(runIds: string[]): { inputTokens: number; outputTokens: number; modelRunCount: number } {
  if (runIds.length === 0) return { inputTokens: 0, outputTokens: 0, modelRunCount: 0 };
  const rows = getDatabase()
    .prepare(`SELECT usage FROM agent_runs WHERE id IN (${placeholders(runIds)})`)
    .all(...runIds) as Array<{ usage: string | null }>;
  let inputTokens = 0;
  let outputTokens = 0;
  let modelRunCount = 0;
  for (const row of rows) {
    if (!row.usage) continue;
    try {
      const usage = typeof row.usage === "string" ? JSON.parse(row.usage) : row.usage;
      inputTokens += Number(usage.inputTokens) || 0;
      outputTokens += Number(usage.outputTokens) || 0;
      modelRunCount++;
    } catch { /* malformed historical usage is ignored */ }
  }
  return { inputTokens, outputTokens, modelRunCount };
}

function collectMetricSources(conductorRunId: string) {
  const db = getDatabase();
  const runIds = readRunTreeIds(conductorRunId);
  const taskAttempts = db
    .prepare("SELECT id, context_snapshot_id FROM task_attempts WHERE conductor_run_id = ? ORDER BY task_id, attempt")
    .all(conductorRunId) as Array<{ id: string; context_snapshot_id: string | null }>;
  const evidenceIds = db
    .prepare("SELECT id FROM task_evidence WHERE conductor_run_id = ? ORDER BY created_at, id")
    .all(conductorRunId) as Array<{ id: string }>;
  const bindings = db
    .prepare(`
      SELECT plan_id, producer_task_id, output_key, artifact_id
      FROM conductor_output_bindings
      WHERE conductor_run_id = ? AND superseded_at IS NULL
      ORDER BY plan_id, producer_task_id, output_key
    `)
    .all(conductorRunId) as Array<{
      plan_id: string;
      producer_task_id: string;
      output_key: string;
      artifact_id: string;
    }>;
  const messageIds = runIds.length > 0
    ? db.prepare(`SELECT id FROM messages WHERE run_id IN (${placeholders(runIds)}) ORDER BY created_at, id`)
      .all(...runIds) as Array<{ id: string }>
    : [];
  const approvalIds = runIds.length > 0
    ? db.prepare(`SELECT id FROM pending_approvals WHERE run_id IN (${placeholders(runIds)}) ORDER BY created_at, id`)
      .all(...runIds) as Array<{ id: string }>
    : [];

  return {
    runIds,
    taskAttemptIds: taskAttempts.map((row) => row.id),
    contextSnapshotIds: taskAttempts.flatMap((row) => row.context_snapshot_id ? [row.context_snapshot_id] : []),
    evidenceIds: evidenceIds.map((row) => row.id),
    outputBindingKeys: bindings.map((row) =>
      `${row.plan_id}:${row.producer_task_id}:${row.output_key}:${row.artifact_id}`
    ),
    messageIds: messageIds.map((row) => row.id),
    approvalIds: approvalIds.map((row) => row.id),
  };
}

// ── Derived rates ───────────────────────────────────────────────────────────

export function computeDerivedRates(raw: ContextQualityRunMetrics): ContextQualityDerivedRates {
  const totalCandidates = raw.contextIncludedItemCount + raw.contextOmittedItemCount;
  const totalOutputClaims = raw.verifiedOutputBindingCount + raw.rejectedOutputClaimCount;

  return {
    upstreamInputHitRate: safeRatio(raw.verifiedInputCount, raw.verifiedInputCount + raw.missingRequiredInputCount),
    upstreamArtifactReadRate: safeRatio(raw.upstreamInputReadCount, raw.verifiedInputCount),
    contextOmissionRate: safeRatio(raw.contextOmittedItemCount, totalCandidates),
    unverifiedOutputRejectionRate: safeRatio(raw.rejectedOutputClaimCount, totalOutputClaims),
    toolFailureRate: safeRatio(raw.failedToolCallCount, raw.toolCallCount),
    taskRetryRate: safeRatio(raw.attemptCount - raw.taskCount, raw.taskCount),
    deploymentSuccessRate: safeRatio(raw.deploymentReadyCount, raw.webAppOutputCount),
    taskCompletionRate: safeRatio(raw.completedTaskCount, raw.taskCount),
  };
}

function safeRatio(numerator: number, denominator: number): number {
  if (denominator === 0) return 0;
  return Math.round((numerator / denominator) * 1000) / 1000;
}
