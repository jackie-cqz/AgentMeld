// ---------------------------------------------------------------------------
// P0: Context Trace Service — query context trace by attemptId or runId
// ---------------------------------------------------------------------------

import { getDatabase } from "@/db/client";
import {
  getTaskAttempt, getContextSnapshot, listEvidenceForAttempt, listCriterionVerdicts,
  type TaskAttemptRecord
} from "@/server/repositories/evidence-repository";
import { getArtifact } from "@/server/repositories";
import type { ContextManifestItem } from "@/shared/task-context-types";
import type {
  ContextTraceAttempt,
  ContextTraceSnapshot,
  ContextTraceUpstreamInput,
  ContextTraceEvidenceSummary,
  ContextTraceVerdictSummary,
  ContextTraceOutputBinding,
  ContextTraceWarning,
  ContextTraceResponse,
  ContextTraceRunTask,
  ContextTraceRunMetrics,
  ContextTraceRunResponse,
  ArtifactReadResult,
} from "@/server/context-trace/context-trace-types";

// ── Main entry points ──────────────────────────────────────────────────────

export function getContextTraceByAttempt(attemptId: string): ContextTraceResponse | { error: string; status: number } {
  const attempt = getTaskAttempt(attemptId);
  if (!attempt) return { error: "Task attempt not found.", status: 404 };

  const db = getDatabase();
  const trace = buildAttemptTrace(attempt, db);
  return trace;
}

export function getContextTraceByRun(conductorRunId: string): ContextTraceRunResponse | { error: string; status: number } {
  const db = getDatabase();
  const rawAttempts = db
    .prepare("SELECT * FROM task_attempts WHERE conductor_run_id = ? AND task_id != 'conductor' ORDER BY task_id, attempt")
    .all(conductorRunId) as Array<ReturnType<typeof getTaskAttempt>>;
  const attempts = rawAttempts.filter((a): a is NonNullable<typeof a> => a != null);

  if (attempts.length === 0) return { error: "No task attempts found for this run.", status: 404 };

  // Get plan for task metadata
  const planRow = db
    .prepare("SELECT plan_json, id FROM conductor_plans WHERE conductor_run_id = ? ORDER BY revision DESC LIMIT 1")
    .get(conductorRunId) as { plan_json: string; id: string } | undefined;

  const planTasks: Array<{ id: string; agentId: string; title?: string; dependsOn?: string[] }> = [];
  if (planRow) {
    try { planTasks.push(...JSON.parse(planRow.plan_json)); } catch { /* ok */ }
  }
  const planTaskMap = new Map(planTasks.map((t) => [t.id, t]));

  // Group attempts by task
  const taskMap = new Map<string, ContextTraceRunTask>();
  for (const att of attempts) {
    let entry = taskMap.get(att.taskId);
    if (!entry) {
      const planTask = planTaskMap.get(att.taskId);
      entry = {
        taskId: att.taskId,
        agentId: att.agentId,
        title: planTask?.title ?? att.taskId,
        dependsOn: planTask?.dependsOn ?? [],
        attempts: [],
        producedBindings: [],
        consumedInputs: [],
      };
      taskMap.set(att.taskId, entry);
    }

    const trace = buildAttemptTrace(att, db);
    entry.attempts.push(trace.attempt);
    entry.producedBindings.push(...trace.outputBindings);
    for (const ci of trace.upstreamInputs) {
      if (!entry.consumedInputs.some((e) => e.artifactId === ci.artifactId)) {
        entry.consumedInputs.push(ci);
      }
    }
  }

  const tasks = Array.from(taskMap.values());
  const metrics = computeRunMetrics(tasks, attempts);
  const firstAttempt = attempts[0];

  return {
    conductorRunId,
    conversationId: firstAttempt?.conversationId ?? "",
    planId: planRow?.id ?? "",
    tasks,
    metrics,
  };
}

// ── Private: build trace for a single attempt ──────────────────────────────

function buildAttemptTrace(att: TaskAttemptRecord, db: ReturnType<typeof getDatabase>): ContextTraceResponse {
  const traceAttempt: ContextTraceAttempt = {
    conversationId: att.conversationId,
    conductorRunId: att.conductorRunId,
    planId: att.planId,
    taskId: att.taskId,
    attemptId: att.id,
    agentId: att.agentId,
    contextSnapshotId: att.contextSnapshotId ?? null,
    executionStatus: att.executionStatus,
    verificationStatus: att.verificationStatus,
    startedAt: att.startedAt ?? null,
    finishedAt: att.finishedAt ?? null,
  };

  // ── Snapshot + manifest ────────────────────────────────────────────────
  let snapshot: ContextTraceSnapshot | null = null;
  let includedManifest: ContextManifestItem[] = [];
  let omittedManifest: ContextManifestItem[] = [];
  if (att.contextSnapshotId) {
    const snap = getContextSnapshot(att.contextSnapshotId);
    if (snap) {
      let manifest: ContextManifestItem[] = [];
      try { manifest = JSON.parse(snap.manifestJson); } catch { /* ok */ }
      snapshot = {
        id: snap.id,
        policyVersion: snap.policyVersion,
        schemaVersion: snap.schemaVersion,
        tokenEstimate: snap.tokenEstimate,
        requiredTokenEstimate: snap.requiredTokenEstimate,
        omittedTokenEstimate: snap.omittedTokenEstimate,
        manifest,
      };
      includedManifest = manifest.filter((m) => m.included);
      omittedManifest = manifest.filter((m) => !m.included);
    }
  }

  // ── Evidence ────────────────────────────────────────────────────────────
  const evidenceRecords = listEvidenceForAttempt(att.id);
  const evidence: ContextTraceEvidenceSummary[] = evidenceRecords.map((ev) => {
    let excerpt = "";
    try {
      const p = JSON.parse(ev.payloadJson);
      excerpt = (p.command ?? p.path ?? p.outputKey ?? JSON.stringify(p).slice(0, 200)) as string;
    } catch { /* ok */ }
    return {
      evidenceId: ev.id,
      type: ev.type,
      status: ev.status,
      trustLevel: ev.trustLevel,
      subjectType: ev.subjectType,
      subjectId: ev.subjectId,
      excerpt: excerpt.slice(0, 200),
      createdAt: ev.createdAt,
    };
  });

  // ── Verdicts ────────────────────────────────────────────────────────────
  const rawVerdicts = listCriterionVerdicts(att.id);
  const verdicts: ContextTraceVerdictSummary[] = rawVerdicts.map((v) => ({
    id: v.id,
    criterionId: v.criterionId,
    validatorType: v.validatorType,
    status: v.status,
    evidenceIds: parseJsonArray(v.evidenceIdsJson),
    reason: v.reason,
  }));

  // ── Output bindings ─────────────────────────────────────────────────────
  const outputBindings: ContextTraceOutputBinding[] = buildOutputBindings(att.conductorRunId, att.planId, att.taskId);

  // ── Upstream inputs ─────────────────────────────────────────────────────
  const upstreamInputs = buildUpstreamInputs(att.taskId, att.conductorRunId, att.planId, att.childRunId ?? null, att.id);

  // ── Warnings ────────────────────────────────────────────────────────────
  const warnings = buildWarnings(att, snapshot, evidence, outputBindings, upstreamInputs, includedManifest);

  return {
    attempt: traceAttempt,
    snapshot,
    upstreamInputs,
    includedManifest,
    omittedManifest,
    evidence,
    verdicts,
    outputBindings,
    warnings,
  };
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function buildOutputBindings(conductorRunId: string, planId: string, taskId: string): ContextTraceOutputBinding[] {
  const db = getDatabase();
  const rows = db
    .prepare("SELECT * FROM conductor_output_bindings WHERE conductor_run_id = ? AND plan_id = ? AND producer_task_id = ?")
    .all(conductorRunId, planId, taskId) as Array<{
      producer_task_id: string; output_key: string; artifact_id: string; created_at: number;
    }>;
  return rows.map((r) => {
    const art = getArtifact(r.artifact_id);
    return {
      producerTaskId: r.producer_task_id,
      outputKey: r.output_key,
      artifactId: r.artifact_id,
      artifactTitle: art?.title ?? r.artifact_id,
      artifactType: art?.type ?? "unknown",
      createdAt: r.created_at,
    };
  });
}

function buildUpstreamInputs(
  taskId: string,
  conductorRunId: string,
  planId: string,
  childRunId: string | null,
  attemptId?: string
): ContextTraceUpstreamInput[] {
  const db = getDatabase();
  const dedup = new Map<string, ContextTraceUpstreamInput>();

  // Get all output bindings for this run
  const allBindings = db
    .prepare("SELECT * FROM conductor_output_bindings WHERE conductor_run_id = ? AND plan_id = ?")
    .all(conductorRunId, planId) as Array<{
      producer_task_id: string; output_key: string; artifact_id: string;
    }>;

  // ── Source 1 (authoritative): context snapshot envelope.upstreamInputs ──
  // This is what the Context Compiler ACTUALLY injected into the prompt.
  // It includes both explicit task.inputs AND dependsOn-derived bindings.
  if (attemptId) {
    try {
      const snapRow = db
        .prepare("SELECT envelope_json FROM task_context_snapshots WHERE attempt_id = ? LIMIT 1")
        .get(attemptId) as { envelope_json: string } | undefined;
      if (snapRow) {
        const envelope = JSON.parse(snapRow.envelope_json) as {
          upstreamInputs?: Array<{ fromTaskId?: string; outputKey?: string; artifactId?: string; artifactVersion?: number; artifactType?: string; title?: string }>;
        };
        if (envelope.upstreamInputs) {
          for (const ui of envelope.upstreamInputs) {
            const key = `${ui.fromTaskId ?? ""}.${ui.outputKey ?? ""}`;
            if (!key || key === "." || dedup.has(key)) continue;
            const art = ui.artifactId ? getArtifact(ui.artifactId) : null;
            const readResult = childRunId ? detectArtifactRead(childRunId, ui.artifactId ?? "") : { readByChildRun: false, readEvidenceIds: [] };
            dedup.set(key, {
              fromTaskId: ui.fromTaskId ?? "",
              outputKey: ui.outputKey ?? "",
              artifactId: ui.artifactId ?? "",
              artifactTitle: ui.title ?? art?.title ?? (ui.artifactId ?? ""),
              artifactType: ui.artifactType ?? art?.type ?? "unknown",
              artifactVersion: ui.artifactVersion ?? art?.version ?? 1,
              bindingVerified: true,
              readByCurrentAttempt: readResult.readByChildRun,
            });
          }
        }
      }
    } catch { /* fall through to plan-based derivation */ }
  }

  // ── Source 2 (fallback): plan_json task.inputs + dependsOn-derived ──
  // If the snapshot approach yielded nothing, derive from plan + bindings.
  if (dedup.size === 0) {
    const planRow = db
      .prepare("SELECT plan_json FROM conductor_plans WHERE conductor_run_id = ? AND id = ? LIMIT 1")
      .get(conductorRunId, planId) as { plan_json: string } | undefined;
    if (planRow) {
      let tasks: Array<{ id: string; dependsOn?: string[]; inputs?: Array<{ fromTaskId: string; outputId: string; required?: boolean }> }> = [];
      try { tasks = JSON.parse(planRow.plan_json); } catch { /* ok */ }
      const task = tasks.find((t) => t.id === taskId);

      // Build input specs the same way the runtime does (buildInputSpecs in child-prompt-builder):
      // explicit task.inputs + dependsOn-derived from output bindings
      const specs = new Map<string, { fromTaskId: string; outputId: string }>();

      // Explicit inputs
      for (const input of task?.inputs ?? []) {
        const key = `${input.fromTaskId}.${input.outputId}`;
        specs.set(key, { fromTaskId: input.fromTaskId, outputId: input.outputId });
      }

      // dependsOn-derived: for each dependency, look up all its output bindings
      for (const dep of task?.dependsOn ?? []) {
        const prefix = `${dep}.`;
        for (const b of allBindings) {
          const bindingKey = `${b.producer_task_id}.${b.output_key}`;
          if (bindingKey.startsWith(prefix) && !specs.has(bindingKey)) {
            specs.set(bindingKey, { fromTaskId: b.producer_task_id, outputId: b.output_key });
          }
        }
      }

      for (const [, spec] of specs) {
        const binding = allBindings.find(
          (b) => b.producer_task_id === spec.fromTaskId && b.output_key === spec.outputId
        );
        if (!binding) {
          dedup.set(`${spec.fromTaskId}.${spec.outputId}`, {
            fromTaskId: spec.fromTaskId,
            outputKey: spec.outputId,
            artifactId: "",
            artifactTitle: `(not found: ${spec.fromTaskId}.${spec.outputId})`,
            artifactType: "unknown",
            artifactVersion: 0,
            bindingVerified: false,
            readByCurrentAttempt: false,
          });
          continue;
        }

        const art = getArtifact(binding.artifact_id);
        const readResult = childRunId ? detectArtifactRead(childRunId, binding.artifact_id) : { readByChildRun: false, readEvidenceIds: [] };
        dedup.set(`${spec.fromTaskId}.${spec.outputId}`, {
          fromTaskId: spec.fromTaskId,
          outputKey: spec.outputId,
          artifactId: binding.artifact_id,
          artifactTitle: art?.title ?? binding.artifact_id,
          artifactType: art?.type ?? "unknown",
          artifactVersion: art?.version ?? 1,
          bindingVerified: true,
          readByCurrentAttempt: readResult.readByChildRun,
        });
      }
    }
  }

  return Array.from(dedup.values());
}

function detectArtifactRead(childRunId: string, artifactId: string): ArtifactReadResult {
  const db = getDatabase();
  const rows = db
    .prepare("SELECT id, payload_json FROM task_evidence WHERE child_run_id = ? AND type = 'artifact_read'")
    .all(childRunId) as Array<{ id: string; payload_json: string }>;

  const evidenceIds: string[] = [];
  for (const row of rows) {
    try {
      const p = JSON.parse(row.payload_json);
      if (p.artifactId === artifactId || row.payload_json.includes(artifactId)) {
        evidenceIds.push(row.id);
      }
    } catch { /* ok */ }
  }

  return { artifactId, readByChildRun: evidenceIds.length > 0, readEvidenceIds: evidenceIds };
}

function buildWarnings(
  att: TaskAttemptRecord,
  snapshot: ContextTraceSnapshot | null,
  evidence: ContextTraceEvidenceSummary[],
  outputBindings: ContextTraceOutputBinding[],
  upstreamInputs: ContextTraceUpstreamInput[],
  includedManifest: ContextManifestItem[],
): ContextTraceWarning[] {
  const warnings: ContextTraceWarning[] = [];

  // missing context snapshot
  if (!snapshot) {
    warnings.push({
      code: "missing_context_snapshot",
      severity: "warning",
      message: `Task ${att.taskId} attempt ${att.id} has no context snapshot.`,
      taskId: att.taskId,
      attemptId: att.id,
    });
  }

  // missing required upstream input
  for (const ui of upstreamInputs) {
    if (!ui.bindingVerified) {
      warnings.push({
        code: "missing_required_upstream_input",
        severity: "error",
        message: `Task ${att.taskId} requires "${ui.fromTaskId}.${ui.outputKey}" but no output binding exists.`,
        taskId: att.taskId,
        attemptId: att.id,
      });
    }
  }

  // unread verified input
  for (const ui of upstreamInputs) {
    if (ui.bindingVerified && !ui.readByCurrentAttempt) {
      warnings.push({
        code: "unread_verified_input",
        severity: "warning",
        message: `Task ${att.taskId} received ${ui.fromTaskId}.${ui.outputKey} as ${ui.artifactId} but did not call read_artifact for it.`,
        taskId: att.taskId,
        attemptId: att.id,
        artifactId: ui.artifactId,
      });
    }
  }

  // output binding missing
  if (evidence.some((e) => e.type === "artifact_created") && outputBindings.length === 0) {
    warnings.push({
      code: "output_binding_missing",
      severity: "warning",
      message: `Task ${att.taskId} has artifact_created evidence but no output binding.`,
      taskId: att.taskId,
      attemptId: att.id,
    });
  }

  // context budget omitted high priority
  if (includedManifest.length === 0 && snapshot && snapshot.omittedTokenEstimate > 0) {
    warnings.push({
      code: "context_budget_omitted_high_priority",
      severity: "warning",
      message: `Task ${att.taskId} had all context items omitted (${snapshot.omittedTokenEstimate} tokens omitted).`,
      taskId: att.taskId,
      attemptId: att.id,
    });
  }

  // tool claim without evidence: reported complete but no build/deploy evidence
  if (att.executionStatus === "reported_complete") {
    const hasBuildEvidence = evidence.some((e) => e.type === "command_executed" || e.type === "test_executed");
    const hasDeployEvidence = evidence.some((e) => e.type === "deployment_created");
    if (!hasBuildEvidence && !hasDeployEvidence) {
      if (evidence.length <= 2) {
        warnings.push({
          code: "tool_claim_without_evidence",
          severity: "info",
          message: `Task ${att.taskId} reported complete but has very sparse evidence (${evidence.length} records).`,
          taskId: att.taskId,
          attemptId: att.id,
        });
      }
    }
  }

  // P1: unverified_output_not_propagated — task produced artifact_created
  // evidence but verification was rejected, so output did NOT propagate.
  if (att.verificationStatus === "rejected") {
    const hasArtifactEvidence = evidence.some((e) => e.type === "artifact_created");
    if (hasArtifactEvidence) {
      warnings.push({
        code: "unverified_output_not_propagated",
        severity: "warning",
        message: `Task ${att.taskId} created artifacts but verification was rejected — outputs were NOT propagated downstream.`,
        taskId: att.taskId,
        attemptId: att.id,
      });
    }
  }

  // P1: guessed_artifact_id — check if agent messages mention artifact IDs
  // that don't appear in evidence (possible hallucination).
  if (att.childRunId) {
    try {
      const db = getDatabase();
      const msgRows = db
        .prepare("SELECT parts, role FROM messages WHERE run_id = ? AND role = 'agent'")
        .all(att.childRunId) as Array<{ parts: string; role: string }>;
      const knownArtifactIds = new Set(evidence.map((e) => e.subjectId));
      for (const row of msgRows) {
        try {
          const parts = JSON.parse(row.parts) as Array<{ type: string; content?: string; artifactId?: string }>;
          for (const p of parts) {
            const refs = extractArtifactRefs(JSON.stringify(p));
            for (const refId of refs) {
              if (!knownArtifactIds.has(refId) && outputBindings.some((b) => b.artifactId !== refId)) {
                if (!warnings.some((w) => w.code === "guessed_artifact_id" && w.artifactId === refId)) {
                  warnings.push({
                    code: "guessed_artifact_id",
                    severity: "warning",
                    message: `Task ${att.taskId} referenced artifact "${refId}" in message but no evidence confirms it was created in this attempt.`,
                    taskId: att.taskId,
                    attemptId: att.id,
                    artifactId: refId,
                  });
                }
              }
            }
          }
        } catch { /* skip unparseable */ }
      }
    } catch { /* best-effort */ }
  }

  return warnings;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function extractArtifactRefs(text: string): string[] {
  const refs: string[] = [];
  // Match artifact ID patterns like art_xxx or art-xxx
  const matches = text.match(/\b(art_[a-zA-Z0-9_-]{8,})\b/g);
  if (matches) refs.push(...matches);
  return [...new Set(refs)];
}

// ── Run metrics ─────────────────────────────────────────────────────────────

function computeRunMetrics(
  tasks: ContextTraceRunTask[],
  attempts: TaskAttemptRecord[],
): ContextTraceRunMetrics {
  let verifiedInputCount = 0;
  let missingRequiredInputCount = 0;
  let upstreamInputReadCount = 0;
  let upstreamInputUnreadCount = 0;
  let evidenceCount = 0;
  let verifiedOutputBindingCount = 0;
  let artifactCreatedCount = 0;
  let deploymentReadyCount = 0;

  for (const task of tasks) {
    for (const ci of task.consumedInputs) {
      if (ci.bindingVerified) verifiedInputCount++;
      else missingRequiredInputCount++;
      if (ci.readByCurrentAttempt) upstreamInputReadCount++;
      else if (ci.bindingVerified) upstreamInputUnreadCount++;
    }
    verifiedOutputBindingCount += task.producedBindings.length;
    // Count artifacts from evidence
    for (const att of task.attempts) {
      const ev = listEvidenceForAttempt(att.attemptId);
      evidenceCount += ev.length;
      artifactCreatedCount += ev.filter((e) => e.type === "artifact_created").length;
      deploymentReadyCount += ev.filter((e) => e.type === "deployment_created" && e.status === "valid").length;
    }
  }

  const completedTaskCount = tasks.filter((t) =>
    t.attempts.some((a) => a.executionStatus === "reported_complete")
  ).length;
  const failedTaskCount = tasks.length - completedTaskCount;

  return {
    taskCount: tasks.length,
    attemptCount: attempts.length,
    completedTaskCount,
    failedTaskCount,
    verifiedInputCount,
    missingRequiredInputCount,
    upstreamInputReadCount,
    upstreamInputUnreadCount,
    evidenceCount,
    verifiedOutputBindingCount,
    artifactCreatedCount,
    deploymentReadyCount,
  };
}

// ── JSON util ───────────────────────────────────────────────────────────────

function parseJsonArray(json: string): string[] {
  try { const v = JSON.parse(json); return Array.isArray(v) ? v : []; } catch { return []; }
}
