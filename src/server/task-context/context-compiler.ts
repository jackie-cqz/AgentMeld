// ---------------------------------------------------------------------------
// P3: Task Context Compiler — 18-step pipeline from data to envelope
// ---------------------------------------------------------------------------

import fs from "fs";
import path from "path";
import type { Agent, Message } from "@/shared/types";
import type { TaskExecutionIdentity, CriterionVerdict } from "@/shared/evidence-types";
import type { TaskContextEnvelope, FailureContext, ContextQualityMetrics } from "@/shared/task-context-types";
import type { ParsedTask } from "@/server/tools/conductor-tools";
import { buildTaskState } from "@/server/task-state/task-state-builder";
import type { ResolvedInput, UpstreamArtifact, ActiveFactEntry } from "@/server/child-prompt-builder";
import { getArtifact } from "@/server/repositories";
import { listCriterionVerdicts } from "@/server/repositories/evidence-repository";
import { buildFailureContext } from "@/server/task-context/failure-context";
import { classifyCandidate, isForbidden } from "@/server/task-context/context-policy";
import { type ContextCandidate, candidateToManifestItem } from "@/server/task-context/context-candidates";
import { qualifyCandidate } from "@/server/task-context/qualification-filter";
import { scoreCandidate, rankCandidates } from "@/server/task-context/relevance-ranker";
import { compressCandidate } from "@/server/task-context/context-compressor";
import { externalizeCandidate } from "@/server/task-context/context-externalizer";
import { packContext } from "@/server/task-context/context-packer";
import { computeBudget, isMandatoryOverBudget } from "@/server/task-context/context-budget";

export interface CompileTaskContextInput {
  conversationId: string;
  conductorRunId: string;
  planId: string;
  planRevision: number;
  task: ParsedTask;
  attemptId: string;
  attempt: number;
  /** P3: contextSnapshotId from conductor (already generated via newContextSnapshotId) */
  contextSnapshotId: string;
  assignedAgent: Agent;
  triggerMessage: Message;
  resolvedInputs: ResolvedInput[];
  upstreamArtifacts: UpstreamArtifact[];
  /** P3: activeFacts already filtered by agent role via getFilteredDefinitionsForAgent */
  activeFacts: ActiveFactEntry[];
  /** Effective workspace root for lightweight directory snapshots. */
  workspacePath?: string;
  previousAttemptId?: string;
  previousChildRunId?: string;
  previousError?: string;
  modelProvider?: string | null;
  systemPromptTokens?: number;
  toolSchemaTokens?: number;
}

export async function compileTaskContext(input: CompileTaskContextInput): Promise<TaskContextEnvelope> {
  const now = Date.now();

  // Step 1: Build identity — use conductor-generated contextSnapshotId, NOT derived
  const identity: TaskExecutionIdentity = {
    conductorRunId: input.conductorRunId,
    planId: input.planId,
    planRevision: input.planRevision,
    taskId: input.task.id,
    attemptId: input.attemptId,
    attempt: input.attempt,
    contextSnapshotId: input.contextSnapshotId,
  };

  if (!identity.taskId || !identity.attemptId) {
    throw new Error("context-compiler: invalid task identity");
  }

  // Step 2-3: Build candidates from all sources
  const candidates: ContextCandidate[] = [];
  const estimateId = `ctx_${input.attemptId}`;
  const userText = extractTextFromMessage(input.triggerMessage);

  // Task objective (mandatory)
  candidates.push({
    id: `${estimateId}_obj`, category: "task", sourceType: "plan", sourceId: input.planId,
    content: { title: input.task.title, objective: input.task.prompt },
    trustLevel: "authoritative", required: true, taskIds: [input.task.id],
    namespaces: [], pathRefs: [], criterionIds: [],
    tokenEstimate: Math.ceil((input.task.prompt?.length ?? 0) / 4), createdAt: now,
  });

  // Step 5-6: Active facts — use pre-filtered agent-specific facts, NOT loadAllActiveFacts
  for (const fact of input.activeFacts) {
    candidates.push({
      id: `${estimateId}_fact_${fact.canonicalKey}`, category: "fact", sourceType: "fact_registry", sourceId: fact.canonicalKey,
      content: { canonicalKey: fact.canonicalKey, value: fact.value },
      trustLevel: fact.trustLevel ?? "verified", required: false, taskIds: [input.task.id],
      namespaces: [fact.canonicalKey.split(".")[0] ?? ""], pathRefs: [], criterionIds: [],
      tokenEstimate: estimateToken(fact.value ?? fact.canonicalKey), createdAt: now,
    });
  }

  // Step 4: User request
  if (userText) {
    candidates.push({
      id: `${estimateId}_user_msg`, category: "recent_message", sourceType: "message", sourceId: input.triggerMessage.id,
      content: userText.slice(0, 2000), trustLevel: "authoritative", required: true, taskIds: [input.task.id],
      namespaces: [], pathRefs: [], criterionIds: [],
      tokenEstimate: Math.ceil(userText.length / 4), createdAt: now,
    });
  }

  // Step 8-9: Verified inputs with full artifact metadata + producer verification
  for (const ri of input.resolvedInputs) {
    if (ri.artifactId) {
      const art = getArtifact(ri.artifactId);
      // P6: Load producer task's verification status to enrich delta trust level.
      // Scope by conversation + conductor run + plan to avoid cross-conversation leaks.
      let producerVerification: { status: string; passedCriterionCount: number } | null = null;
      try {
        const db = (await import("@/db/client")).getDatabase();
        const attempts = db
          .prepare(`SELECT id, verification_status FROM task_attempts
            WHERE conversation_id = ? AND conductor_run_id = ? AND plan_id = ?
              AND task_id = ? AND execution_status = 'reported_complete'
            ORDER BY attempt DESC LIMIT 1`)
          .all(input.conversationId, input.conductorRunId, input.planId, ri.fromTaskId) as Array<{ id: string; verification_status: string }>;
        if (attempts.length > 0) {
          const verdicts = db
            .prepare("SELECT COUNT(*) AS cnt FROM criterion_verdicts WHERE attempt_id = ? AND status = 'passed'")
            .get(attempts[0].id) as { cnt: number };
          producerVerification = { status: attempts[0].verification_status, passedCriterionCount: verdicts.cnt };
        }
      } catch { /* best-effort */ }

      const trust: import("@/shared/evidence-types").EvidenceTrustLevel =
        producerVerification?.status === "verified" ? "verified" : "accepted";

      candidates.push({
        id: `${estimateId}_inp_${ri.outputId}`, category: "upstream_input", sourceType: "artifact", sourceId: ri.artifactId,
        content: {
          artifactId: ri.artifactId,
          title: art?.title ?? ri.outputId,
          type: art?.type ?? "unknown",
          version: art?.version ?? 1,
          producerTaskId: ri.fromTaskId,
          producerVerification,
        },
        trustLevel: trust, required: ri.required, taskIds: [input.task.id, ri.fromTaskId],
        namespaces: [], pathRefs: [], criterionIds: [],
        tokenEstimate: 80, createdAt: now,
      });
    }
  }

  // Step 12: Workspace target paths
  const workspaceSnapshot = input.workspacePath ? buildWorkspaceSnapshot(input.workspacePath) : null;
  if (workspaceSnapshot) {
    candidates.push({
      id: `${estimateId}_ws_snapshot`, category: "workspace", sourceType: "workspace_snapshot", sourceId: ".",
      content: workspaceSnapshot, trustLevel: "verified", required: false, taskIds: [input.task.id],
      namespaces: [], pathRefs: workspaceSnapshot.entries.map(e => e.path), criterionIds: [],
      tokenEstimate: estimateToken(workspaceSnapshot), createdAt: now,
    });
  }

  for (const tp of input.task.targetPaths ?? []) {
    candidates.push({
      id: `${estimateId}_ws_${tp}`, category: "workspace", sourceType: "targetPath", sourceId: tp,
      content: { path: tp }, trustLevel: "verified", required: false, taskIds: [input.task.id],
      namespaces: [], pathRefs: [tp], criterionIds: [],
      tokenEstimate: 30, createdAt: now,
    });
  }

  // Step 11: Failure context — load real verdicts from previous attempt
  let failureCtx: FailureContext | null = null;
  if (input.attempt > 1 && input.previousAttemptId) {
    let previousVerdicts: Parameters<typeof buildFailureContext>[0]["failedCriteria"] = [];
    try {
      // P5: VerdictRecord.evidenceIdsJson (string) → CriterionVerdict.evidenceIds (string[])
      const rawVerdicts = listCriterionVerdicts(input.previousAttemptId);
      previousVerdicts = rawVerdicts.map(v => ({
        id: v.id,
        criterionId: v.criterionId,
        status: v.status as "passed" | "failed" | "missing" | "needs_review",
        validatorType: v.validatorType as CriterionVerdict["validatorType"],
        evidenceIds: parseEvidenceIds(v.evidenceIdsJson),
        reason: v.reason,
        checkedAt: v.checkedAt,
      }));
    } catch { /* best-effort */ }
    failureCtx = await buildFailureContext({
      previousAttemptId: input.previousAttemptId,
      previousChildRunId: input.previousChildRunId ?? "", previousError: input.previousError,
      failedCriteria: previousVerdicts,
    });
    candidates.push({
      id: `${estimateId}_fail`, category: "failure", sourceType: "evaluation", sourceId: input.previousAttemptId,
      content: failureCtx, trustLevel: "verified", required: true, taskIds: [input.task.id],
      namespaces: [], pathRefs: [], criterionIds: [],
      tokenEstimate: 200, createdAt: now,
    });
  }

  // ── P8: Context Retrieval (Step 13) — FTS5 search for Optional layer ──
  // Retrieved items are ALWAYS trust-level "retrieved" and can only enter
  // the Optional budget. They must NEVER override active Facts or verified inputs.
  let retrievalHitCount = 0;
  try {
    const userQuery = extractTextFromMessage(input.triggerMessage);
    if (userQuery && userQuery.length > 10) {
      // Collect source IDs already in candidates to avoid duplicates
      const existingSourceIds = candidates.map(c => c.sourceId);
      const { retrieveContext } = await import("@/server/task-context/context-retriever");
      const retrieved = retrieveContext({
        conversationId: input.conversationId,
        query: userQuery,
        maxResults: 10,
        taskId: input.task.id,
        excludeSourceIds: existingSourceIds,
      });
      retrievalHitCount = retrieved.length;
      for (const ret of retrieved) {
        candidates.push({
          id: `${estimateId}_ret_${ret.sourceId}`,
          category: "retrieved_history",
          sourceType: ret.sourceType,
          sourceId: ret.sourceId,
          content: ret.snippet,
          trustLevel: "retrieved",
          required: false, // P8: retrieved = Optional tier only
          taskIds: ret.taskId ? [ret.taskId] : [],
          namespaces: [],
          pathRefs: [],
          criterionIds: [],
          tokenEstimate: Math.ceil(ret.snippet.length / 4),
          createdAt: ret.createdAt,
        });
      }
    }
  } catch {
    // FTS5 may not be available — retrieval is best-effort, never blocks
  }

  // ── P3: Qualification Hard Filter (Step 14) ──────────────────────────
  const dagTaskIds = [input.task.id, ...input.task.dependsOn];
  const qualified = candidates.filter(c => {
    // First: hard filter
    const qResult = qualifyCandidate(c, {
      conversationId: input.conversationId,
      candidateConversationId: input.conversationId,
      taskId: input.task.id,
      dagTaskIds,
    });
    if (!qResult.qualified) return false;

    // Fact lifecycle filter
    if (c.category === "fact") {
      if (isForbidden(c.category, c.trustLevel)) return false;
      // Filter: only facts matching the agent-filtered list
      const matched = input.activeFacts.some(f => f.canonicalKey === (c.content as { canonicalKey?: string })?.canonicalKey);
      if (!matched) return false;
    }

    // Forbidden items (unverified outputs, superseded facts)
    if (isForbidden(c.category, c.trustLevel)) return false;

    return true;
  });

  // ── P3: Relevance Ranker + Compressor + Externalizer (Steps 15-16) ──
  const dagDepTaskIds = input.task.dependsOn;
  const targetPaths = input.task.targetPaths ?? [];

  const scored = rankCandidates(
    qualified.map(c => {
      const tier = classifyCandidate(c.category, c.sourceType, c.required, c.trustLevel);
      return scoreCandidate(c, tier, { taskId: input.task.id, dagDepTaskIds, targetPaths });
    })
  );

  // Compress non-mandatory items
  const compressed = scored.map(s => ({
    ...s,
    candidate: {
      ...s.candidate,
      content: s.tier.tier !== "mandatory"
        ? compressCandidate(s.candidate, s.tier.tier as "high" | "optional").compressedContent
        : s.candidate.content,
    },
  }));

  // Externalize large items
  const externalized = compressed.map(s => {
    const ext = externalizeCandidate(s.candidate);
    if ("refType" in ext) {
      // Replace candidate content with reference
      return {
        ...s,
        candidate: {
          ...s.candidate,
          content: ext,
          tokenEstimate: 20, // ref is tiny
        },
      };
    }
    return s;
  });

  // ── P3: Budget + Packer (Step 15-16) ────────────────────────────────
  const availableBudget = computeBudget(
    input.modelProvider,
    input.systemPromptTokens ?? 1000,
    input.toolSchemaTokens ?? 2000,
    estimateToken(input.task.prompt ?? "")
  );
  const mandatoryTokens = scored
    .filter(s => s.tier.tier === "mandatory")
    .reduce((s, sc) => s + sc.candidate.tokenEstimate, 0);

  // Mandatory overflow check — return blocked envelope, do NOT call model
  if (isMandatoryOverBudget(mandatoryTokens, availableBudget)) {
    const qm = buildQualityMetrics({
      packed: [],
      omitted: scored.map(s => ({ candidate: s.candidate, reason: "budget" })),
      budget: { maxInputTokens: availableBudget, requiredTokens: mandatoryTokens, optionalTokens: 0, omittedTokens: mandatoryTokens - availableBudget },
      retrievalHits: retrievalHitCount,
      staleRejected: 0,
      unverifiedRejected: 0,
      unrelatedRejected: 0,
      verifiedInputs: 0,
    });
    return {
      schemaVersion: 1,
      policyVersion: "evidence-context-p3-v1",
      blocked: true,
      identity,
      task: { title: input.task.title, objective: input.task.prompt, assignedAgentId: input.task.agentId, dependsOn: input.task.dependsOn },
      requirements: {
        constraints: input.activeFacts.map(f => ({ canonicalKey: f.canonicalKey, value: f.value })),
        expectedOutputs: (input.task.expectedOutputs ?? []).map(eo => ({ outputKey: eo.id, type: eo.type, required: eo.required ?? true })),
      },
      upstreamInputs: [],
      includedContextItems: [],
      failureContext: null,
      manifest: scored.map(s => candidateToManifestItem(s.candidate, s.tier.tier === "mandatory", "budget")),
      budget: { maxInputTokens: availableBudget, requiredTokens: mandatoryTokens, optionalTokens: 0, omittedTokens: mandatoryTokens - availableBudget },
      qualityMetrics: qm,
      createdAt: now,
    };
  }

  // Pack using P3 packer
  const { packed, omitted, budget } = packContext(externalized, availableBudget);

  const manifest = [
    ...packed.map(c => candidateToManifestItem(c, true)),
    ...omitted.map(o => candidateToManifestItem(o.candidate, false, o.reason)),
  ];

  // Build upstream inputs from packed items only (not from all resolvedInputs)
  const upstreamInputs = packed
    .filter(c => c.category === "upstream_input")
    .map(c => {
      const inp = c.content as { artifactId?: string; title?: string; type?: string; version?: number };
      const ri = input.resolvedInputs.find(r => r.artifactId === inp.artifactId);
      return {
        fromTaskId: ri?.fromTaskId ?? "",
        outputKey: ri?.outputId ?? "",
        artifactId: inp.artifactId ?? "",
        artifactVersion: inp.version ?? 1,
        artifactType: inp.type ?? "unknown",
        title: inp.title ?? "",
        verificationId: "",
        evidenceIds: [] as string[],
      };
    });

  // Build includedContextItems from packed
  const includedContextItems = packed.map(c => ({
    category: c.category,
    sourceType: c.sourceType,
    sourceId: c.sourceId,
    content: c.content,
    trustLevel: c.trustLevel,
    required: c.required,
    tokenEstimate: c.tokenEstimate,
  }));

  // Build constraints from packed facts only (not all activeFacts)
  const constraints = packed
    .filter(c => c.category === "fact")
    .map(c => c.content as { canonicalKey?: string; value?: unknown });

  // P8: Compute quality metrics from the ACTUAL packing result
  const qm = buildQualityMetrics({
    packed,
    omitted,
    budget,
    retrievalHits: retrievalHitCount,
    staleRejected: omitted.filter(o => o.reason === "stale").length,
    unverifiedRejected: omitted.filter(o => o.reason === "unverified").length,
    unrelatedRejected: omitted.filter(o => o.reason === "unrelated").length,
    verifiedInputs: upstreamInputs.length,
  });

  // Step 17: Build envelope — only packed items become context
  return {
    schemaVersion: 1,
    policyVersion: "evidence-context-p3-v1",
    blocked: false,
    identity,
    task: { title: input.task.title, objective: input.task.prompt, assignedAgentId: input.task.agentId, dependsOn: input.task.dependsOn },
    requirements: {
      constraints,
      expectedOutputs: (input.task.expectedOutputs ?? []).map(eo => ({ outputKey: eo.id, type: eo.type, required: eo.required ?? true })),
    },
    upstreamInputs,
    includedContextItems,
    failureContext: failureCtx,
    manifest,
    budget,
    // P1: Build structured task state from compiler input + DB evidence
    taskState: buildTaskState({
      task: input.task,
      resolvedInputs: input.resolvedInputs,
      attemptId: input.attemptId,
      attempt: input.attempt,
      planId: input.planId,
      previousAttemptId: input.previousAttemptId,
      previousError: input.previousError,
      agentCapabilities: input.assignedAgent.capabilities,
      agentName: input.assignedAgent.name,
    }),
    qualityMetrics: qm,
    createdAt: now,
  };
}

function extractTextFromMessage(msg: Message): string {
  return msg.parts.filter(p => p.type === "text").map(p => p.content).join("\n");
}

function estimateToken(content: unknown): number {
  const s = typeof content === "string" ? content : JSON.stringify(content);
  return Math.ceil(s.length / 4);
}

function parseEvidenceIds(json: string): string[] {
  try { const v = JSON.parse(json); return Array.isArray(v) ? v : []; } catch { return []; }
}

// ── P8: Quality metrics builder ─────────────────────────────────────────────
// Build from the ACTUAL packContext output (packed, omitted, budget), NOT from
// the pre-pack scored array. This ensures omittedTokens reflects real budget
// cuts and includedItemCount matches what the model actually receives.

interface MetricCandidate {
  tokenEstimate: number;
  required: boolean;
  trustLevel: string;
  category: string;
}

function buildQualityMetrics(params: {
  packed: MetricCandidate[];
  omitted: Array<{ candidate: MetricCandidate; reason: string }>;
  budget: { maxInputTokens: number; requiredTokens: number; optionalTokens: number; omittedTokens: number };
  retrievalHits: number;
  staleRejected: number;
  unverifiedRejected: number;
  unrelatedRejected: number;
  verifiedInputs: number;
}): ContextQualityMetrics {
  const { packed, omitted, budget, retrievalHits, staleRejected, unverifiedRejected, unrelatedRejected, verifiedInputs } = params;
  const allCandidates = [...packed, ...omitted.map(o => o.candidate)];
  return {
    totalTokens: allCandidates.reduce((s, c) => s + c.tokenEstimate, 0),
    requiredTokens: budget.requiredTokens,
    optionalTokens: budget.optionalTokens,
    omittedTokens: budget.omittedTokens,
    includedItemCount: packed.length,
    staleItemRejectedCount: staleRejected,
    unverifiedItemRejectedCount: unverifiedRejected,
    unrelatedItemRejectedCount: unrelatedRejected,
    verifiedInputCount: verifiedInputs,
    retrievalHitCount: retrievalHits,
  };
}

interface WorkspaceSnapshotEntry {
  path: string;
  type: "file" | "directory";
}

interface WorkspaceSnapshot {
  root: ".";
  maxDepth: number;
  maxEntries: number;
  truncated: boolean;
  entries: WorkspaceSnapshotEntry[];
  note?: string;
}

const WORKSPACE_SNAPSHOT_MAX_DEPTH = 3;
const WORKSPACE_SNAPSHOT_MAX_ENTRIES = 80;
const WORKSPACE_SNAPSHOT_SKIP_NAMES = new Set([
  ".git",
  ".next",
  ".turbo",
  ".vite",
  "node_modules",
  "coverage",
]);
const WORKSPACE_SNAPSHOT_SHALLOW_NAMES = new Set([
  "build",
  "dist",
  "out",
]);

function buildWorkspaceSnapshot(workspacePath: string): WorkspaceSnapshot | null {
  if (!fs.existsSync(workspacePath)) {
    return null;
  }

  const entries: WorkspaceSnapshotEntry[] = [];
  let truncated = false;

  function walk(currentPath: string, relativeBase: string, depth: number): void {
    if (depth > WORKSPACE_SNAPSHOT_MAX_DEPTH || truncated) return;

    let dirents: fs.Dirent[];
    try {
      dirents = fs.readdirSync(currentPath, { withFileTypes: true })
        .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
    } catch {
      return;
    }

    for (const dirent of dirents) {
      if (entries.length >= WORKSPACE_SNAPSHOT_MAX_ENTRIES) {
        truncated = true;
        return;
      }
      if (WORKSPACE_SNAPSHOT_SKIP_NAMES.has(dirent.name)) continue;

      const rel = normalizeWorkspacePath(path.join(relativeBase, dirent.name));
      const type = dirent.isDirectory() ? "directory" : "file";
      entries.push({ path: rel, type });

      if (
        dirent.isDirectory() &&
        !WORKSPACE_SNAPSHOT_SHALLOW_NAMES.has(dirent.name) &&
        depth < WORKSPACE_SNAPSHOT_MAX_DEPTH
      ) {
        walk(path.join(currentPath, dirent.name), rel, depth + 1);
      }
    }
  }

  walk(workspacePath, "", 0);
  return {
    root: ".",
    maxDepth: WORKSPACE_SNAPSHOT_MAX_DEPTH,
    maxEntries: WORKSPACE_SNAPSHOT_MAX_ENTRIES,
    truncated,
    entries,
    note: entries.length === 0
      ? "Workspace is currently empty."
      : "Lightweight workspace file list only; use fs_read for file contents before editing.",
  };
}

function normalizeWorkspacePath(inputPath: string): string {
  return inputPath.split(path.sep).join("/");
}
