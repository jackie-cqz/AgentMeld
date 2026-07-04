// ---------------------------------------------------------------------------
// P3: Task Context Compiler — 18-step pipeline from data to envelope
// ---------------------------------------------------------------------------

import type { Agent, Message } from "@/shared/types";
import type { TaskExecutionIdentity } from "@/shared/evidence-types";
import type { TaskContextEnvelope, FailureContext } from "@/shared/task-context-types";
import type { ParsedTask } from "@/server/tools/conductor-tools";
import type { ResolvedInput, UpstreamArtifact, ActiveFactEntry } from "@/server/child-prompt-builder";
import { getArtifact } from "@/server/repositories";
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
  previousAttemptId?: string;
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

  // Step 8-9: Verified inputs with full artifact metadata
  for (const ri of input.resolvedInputs) {
    if (ri.artifactId) {
      const art = getArtifact(ri.artifactId);
      candidates.push({
        id: `${estimateId}_inp_${ri.outputId}`, category: "upstream_input", sourceType: "artifact", sourceId: ri.artifactId,
        content: { artifactId: ri.artifactId, title: art?.title ?? ri.outputId, type: art?.type ?? "unknown", version: art?.version ?? 1 },
        trustLevel: "verified", required: ri.required, taskIds: [input.task.id, ri.fromTaskId],
        namespaces: [], pathRefs: [], criterionIds: [],
        tokenEstimate: 80, createdAt: now,
      });
    }
  }

  // Step 12: Workspace target paths
  for (const tp of input.task.targetPaths ?? []) {
    candidates.push({
      id: `${estimateId}_ws_${tp}`, category: "workspace", sourceType: "targetPath", sourceId: tp,
      content: { path: tp }, trustLevel: "verified", required: false, taskIds: [input.task.id],
      namespaces: [], pathRefs: [tp], criterionIds: [],
      tokenEstimate: 30, createdAt: now,
    });
  }

  // Step 11: Failure context
  let failureCtx: FailureContext | null = null;
  if (input.attempt > 1 && input.previousAttemptId) {
    failureCtx = await buildFailureContext({
      previousAttemptId: input.previousAttemptId,
      previousChildRunId: "", previousError: input.previousError,
      failedCriteria: [],
    });
    candidates.push({
      id: `${estimateId}_fail`, category: "failure", sourceType: "evaluation", sourceId: input.previousAttemptId,
      content: failureCtx, trustLevel: "verified", required: true, taskIds: [input.task.id],
      namespaces: [], pathRefs: [], criterionIds: [],
      tokenEstimate: 200, createdAt: now,
    });
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
