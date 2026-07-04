// ---------------------------------------------------------------------------
// P3: Qualification Filter — deterministic Hard Filter per §9.3.2
// ---------------------------------------------------------------------------

import type { ContextCandidate } from "@/server/task-context/context-candidates";

export type QualificationReasonCode =
  | "wrong_conversation"
  | "unrelated_dag_branch"
  | "unverified_output"
  | "superseded_fact"
  | "pending_fact"
  | "rejected_fact"
  | "stale_evidence"
  | "private_agent_trace"
  | "scope_denied";

export type QualificationDecision =
  | { qualified: true; reason: string }
  | { qualified: false; reasonCode: QualificationReasonCode; reason: string };

/**
 * Hard Filter — deterministic, no LLM.
 * Filters candidates by: conversation scope → DAG dependency → fact lifecycle → verification → evidence status.
 * Each excluded candidate gets a stable reasonCode.
 */
export function qualifyCandidate(
  candidate: ContextCandidate,
  context: {
    conversationId: string;
    candidateConversationId: string;
    taskId: string;
    dagTaskIds: string[];
  }
): QualificationDecision {
  // 1. Conversation scope
  if (candidate.sourceType !== "plan" && candidate.sourceType !== "fact_registry") {
    if (context.candidateConversationId && context.candidateConversationId !== context.conversationId) {
      return { qualified: false, reasonCode: "wrong_conversation", reason: `candidate belongs to conversation ${context.candidateConversationId}` };
    }
  }

  // 2. DAG dependency — only task-scoped candidates need DAG check
  if (candidate.taskIds.length > 0 && !candidate.taskIds.includes(context.taskId)) {
    const isInDag = candidate.taskIds.some(id => context.dagTaskIds.includes(id));
    if (!isInDag) {
      return { qualified: false, reasonCode: "unrelated_dag_branch", reason: `candidate task IDs [${candidate.taskIds}] not in DAG [${context.dagTaskIds}]` };
    }
  }

  // 3. Fact lifecycle — superseded/pending/rejected facts excluded
  if (candidate.category === "fact") {
    const status = (candidate.content as { status?: string })?.status;
    if (status === "superseded") {
      return { qualified: false, reasonCode: "superseded_fact", reason: "fact has been superseded" };
    }
    if (status === "pending") {
      return { qualified: false, reasonCode: "pending_fact", reason: "fact is pending approval" };
    }
    if (status === "rejected") {
      return { qualified: false, reasonCode: "rejected_fact", reason: "fact was rejected" };
    }
  }

  // 4. Unverified output
  if (candidate.category === "upstream_input" && candidate.trustLevel === "reported") {
    return { qualified: false, reasonCode: "unverified_output", reason: "upstream output is reported but not verified" };
  }

  // 5. Stale evidence
  if (candidate.category === "evidence" && candidate.trustLevel === "retrieved") {
    const age = Date.now() - candidate.createdAt;
    if (age > 3600000) { // 1 hour
      return { qualified: false, reasonCode: "stale_evidence", reason: `evidence is ${Math.round(age / 60000)}min old` };
    }
  }

  return { qualified: true, reason: "passed hard filter" };
}
