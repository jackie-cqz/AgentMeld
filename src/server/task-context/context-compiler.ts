// ---------------------------------------------------------------------------
// P3: Task Context Compiler — 18-step pipeline from data to envelope
// ---------------------------------------------------------------------------

import type { Agent, Message } from "@/shared/types";
import type { TaskExecutionIdentity } from "@/shared/evidence-types";
import type { TaskContextEnvelope, ContextManifestItem, FailureContext } from "@/shared/task-context-types";
import type { ParsedTask } from "@/server/tools/conductor-tools";
import type { ResolvedInput, UpstreamArtifact, ActiveFactEntry } from "@/server/child-prompt-builder";
import { loadActiveFacts } from "@/server/context-facts/fact-service";
import { getFilteredDefinitionsForAgent } from "@/server/context-facts/fact-agent-dto";
import { getArtifact } from "@/server/repositories";
import { buildFailureContext } from "@/server/task-context/failure-context";
import { classifyCandidate, isForbidden } from "@/server/task-context/context-policy";
import { type ContextCandidate, candidateToManifestItem } from "@/server/task-context/context-candidates";
import { computeBudget, allocateBudget, isMandatoryOverBudget } from "@/server/task-context/context-budget";

export interface CompileTaskContextInput {
  conversationId: string;
  conductorRunId: string;
  planId: string;
  planRevision: number;
  task: ParsedTask;
  attemptId: string;
  attempt: number;
  assignedAgent: Agent;
  triggerMessage: Message;
  resolvedInputs: ResolvedInput[];
  upstreamArtifacts: UpstreamArtifact[];
  activeFacts: ActiveFactEntry[];
  previousAttemptId?: string;
  previousError?: string;
  modelProvider?: string | null;
  systemPromptTokens?: number;
  toolSchemaTokens?: number;
}

export async function compileTaskContext(input: CompileTaskContextInput): Promise<TaskContextEnvelope> {
  const now = Date.now();
  const identity: TaskExecutionIdentity = {
    conductorRunId: input.conductorRunId,
    planId: input.planId,
    planRevision: input.planRevision,
    taskId: input.task.id,
    attemptId: input.attemptId,
    attempt: input.attempt,
    contextSnapshotId: input.attemptId + "_ctx",
  };

  // Step 1: Validate task identity
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

  // Active facts (step 5-6)
  const conversationFacts = loadActiveFacts(input.conversationId);
  for (const fact of conversationFacts) {
    candidates.push({
      id: `${estimateId}_fact_${fact.id}`, category: "fact", sourceType: "fact_registry", sourceId: fact.id,
      content: { canonicalKey: fact.canonicalKey, value: fact.value },
      trustLevel: fact.trustLevel, required: false, taskIds: [input.task.id],
      namespaces: [fact.canonicalKey.split(".")[0] ?? ""], pathRefs: [], criterionIds: [],
      tokenEstimate: estimateToken(fact.value ?? fact.canonicalKey), createdAt: fact.createdAt,
    });
  }

  // User request (step 4)
  if (userText) {
    candidates.push({
      id: `${estimateId}_user_msg`, category: "recent_message", sourceType: "message", sourceId: input.triggerMessage.id,
      content: userText.slice(0, 2000), trustLevel: "authoritative", required: true, taskIds: [input.task.id],
      namespaces: [], pathRefs: [], criterionIds: [],
      tokenEstimate: Math.ceil(userText.length / 4), createdAt: now,
    });
  }

  // Verified inputs (step 8-9)
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

  // Target paths (step 12) — workspace snapshot
  for (const tp of input.task.targetPaths ?? []) {
    candidates.push({
      id: `${estimateId}_ws_${tp}`, category: "workspace", sourceType: "targetPath", sourceId: tp,
      content: { path: tp }, trustLevel: "verified", required: false, taskIds: [input.task.id],
      namespaces: [], pathRefs: [tp], criterionIds: [],
      tokenEstimate: 30, createdAt: now,
    });
  }

  // Failure context (step 11)
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

  // Step 14: Filter out superseded/pending/rejected/forbidden
  const qualified = candidates.filter(c => {
    if (c.category === "fact") {
      const fact = conversationFacts.find(f => f.id === c.sourceId);
      if (fact && fact.status !== "active") return false;
    }
    if (isForbidden(c.category, c.trustLevel)) return false;
    return true;
  });

  // Step 15: Classify and compute budget
  const classified = qualified.map((c, i) => ({ candidate: c, tier: classifyCandidate(c.category, c.sourceType, c.required, c.trustLevel), rank: qualified.length - i }));
  const availableBudget = computeBudget(input.modelProvider, input.systemPromptTokens ?? 1000, input.toolSchemaTokens ?? 2000, estimateToken(input.task.prompt ?? ""));
  const mandatoryTokens = classified.filter(cl => cl.tier.tier === "mandatory").reduce((s, cl) => s + cl.candidate.tokenEstimate, 0);

  // Check mandatory overflow
  if (isMandatoryOverBudget(mandatoryTokens, availableBudget)) {
    // Return a minimal blocked envelope
    return {
      schemaVersion: 1,
      policyVersion: "evidence-context-p3-v1",
      identity,
      task: { title: input.task.title, objective: input.task.prompt, assignedAgentId: input.task.agentId, dependsOn: input.task.dependsOn },
      requirements: { constraints: [], expectedOutputs: (input.task.expectedOutputs ?? []).map(eo => ({ outputKey: eo.id, type: eo.type, required: eo.required ?? true })) },
      upstreamInputs: [],
      failureContext: null,
      manifest: classified.map(cl => candidateToManifestItem(cl.candidate, cl.tier.tier === "mandatory", "budget")),
      budget: { maxInputTokens: availableBudget, requiredTokens: mandatoryTokens, optionalTokens: 0, omittedTokens: mandatoryTokens - availableBudget },
      createdAt: now,
    };
  }

  // Step 15-16: Budget allocation + manifest
  const { packed, omitted } = allocateBudget(classified, availableBudget);
  const manifest = [...packed.map(c => candidateToManifestItem(c, true)), ...omitted.map(o => candidateToManifestItem(o.candidate, false, o.reason))];

  // Step 17: Build envelope
  return {
    schemaVersion: 1,
    policyVersion: "evidence-context-p3-v1",
    identity,
    task: { title: input.task.title, objective: input.task.prompt, assignedAgentId: input.task.agentId, dependsOn: input.task.dependsOn },
    requirements: {
      constraints: conversationFacts.filter(f => f.status === "active").map(f => ({ canonicalKey: f.canonicalKey, value: f.value })),
      expectedOutputs: (input.task.expectedOutputs ?? []).map(eo => ({ outputKey: eo.id, type: eo.type, required: eo.required ?? true })),
    },
    upstreamInputs: input.resolvedInputs.filter(ri => ri.artifactId).map(ri => ({ fromTaskId: ri.fromTaskId, outputKey: ri.outputId, artifactId: ri.artifactId!, artifactVersion: 0, artifactType: "unknown", title: ri.outputId, verificationId: "", evidenceIds: [] })),
    failureContext: failureCtx,
    manifest,
    budget: {
      maxInputTokens: availableBudget,
      requiredTokens: mandatoryTokens,
      optionalTokens: packed.filter(p => p.category !== "task" && p.category !== "failure").reduce((s, p) => s + p.tokenEstimate, 0),
      omittedTokens: omitted.reduce((s, o) => s + o.candidate.tokenEstimate, 0),
    },
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
