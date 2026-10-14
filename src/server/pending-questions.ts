import { nanoid } from "nanoid";
import { eventBus } from "@/server/event-bus";
import { cancelApproval, persistApproval, resolveApproval, SYSTEM_RESOLVED_BY } from "@/server/repositories";
import { insertEvidence } from "@/server/repositories/evidence-repository";
import { getDatabase } from "@/db/client";
import { newEvidenceId } from "@/shared/ids";
import type { PendingQuestion } from "@/shared/types";

type AnswerResolver = (answers: Record<string, string>) => void;

interface QuestionEntry {
  question: PendingQuestion;
  resolver: AnswerResolver;
}

declare global {
  var __agentMeldPendingQuestions: Map<string, QuestionEntry> | undefined;
}

function getStore(): Map<string, QuestionEntry> {
  if (!globalThis.__agentMeldPendingQuestions) {
    globalThis.__agentMeldPendingQuestions = new Map();
  }
  return globalThis.__agentMeldPendingQuestions;
}

export function registerPendingQuestion(
  conversationId: string,
  agentId: string,
  runId: string,
  questions: PendingQuestion["questions"]
): Promise<Record<string, string>> {
  const store = getStore();
  const id = `pq_${nanoid(12)}`;
  const now = Date.now();

  // P2: Persist to DB
  persistApproval({
    id, conversationId, agentId, runId,
    approvalType: "ask_user",
    payloadJson: JSON.stringify(questions),
    now
  });

  return new Promise((resolve) => {
    const entry: QuestionEntry = {
      question: { id, conversationId, agentId, runId, questions, createdAt: now },
      resolver: (answers) => {
        resolve(answers);
      }
    };
    store.set(id, entry);

    eventBus.publish({
      type: "ask_user.pending",
      conversationId,
      timestamp: now,
      pendingQuestion: entry.question
    });
  });
}

export function getPendingQuestion(id: string): QuestionEntry | undefined {
  return getStore().get(id);
}

export function getPendingQuestionsForConversation(conversationId: string): PendingQuestion[] {
  return Array.from(getStore().values())
    .map((e) => e.question)
    .filter((q) => q.conversationId === conversationId);
}

export function getAllPendingQuestions(): PendingQuestion[] {
  return Array.from(getStore().values()).map((entry) => entry.question);
}

export function answerQuestion(
  id: string,
  answers: Record<string, string>,
  resolvedBy?: string | null
): boolean {
  const store = getStore();
  const entry = store.get(id);
  if (!entry) return false;
  const now = Date.now();
  if (!resolveApproval(id, true, now, resolvedBy ?? null)) return false;

  // P1: Record user_answer evidence — must use a real task_attempt row for FK
  try {
    const q = entry.question;
    const firstQ = q.questions[0]?.question ?? "";
    const db = getDatabase();
    // P1: Look up the real task attempt for correct identity fields
    let attempt: Record<string, unknown> | undefined = (db
      .prepare("SELECT * FROM task_attempts WHERE child_run_id = ? LIMIT 1")
      .all(q.runId) as Array<Record<string, unknown>>)[0];
    // Fallback: conductor-level question before execution — create meta-attempt
    if (!attempt) {
      const planRow = db.prepare("SELECT id, revision FROM conductor_plans WHERE conductor_run_id = ? ORDER BY revision DESC LIMIT 1").get(q.runId) as { id: string; revision: number } | undefined;
      const realPlanId = planRow?.id ?? `plan_${q.runId}_init`;
      const metaId = `ta_conductor_${realPlanId}`;
      // Written terminal, like the approval path in dispatch-plan-manager.ts: this
      // row is an evidence container, not an in-flight attempt. The question's
      // pending state lives in pending_questions/pending_approvals, and nothing
      // finishes this row when the user abandons the plan instead of approving it,
      // so a 'running' row here could leak forever.
      // (Reuses this function's `now` rather than shadowing it.)
      db.prepare(`
        INSERT OR IGNORE INTO task_attempts (id, conductor_run_id, conversation_id, plan_id, plan_revision, task_id, agent_id, attempt, execution_status, verification_status, started_at, finished_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 'conductor', ?, 0, 'reported_complete', 'not_started', ?, ?, ?, ?)
      `).run(metaId, q.runId, q.conversationId, realPlanId, planRow?.revision ?? 0, q.agentId, now, now, now, now);
      attempt = db.prepare("SELECT * FROM task_attempts WHERE id = ?").get(metaId) as Record<string, unknown> | undefined;
    }
    if (attempt) {
      insertEvidence({
        id: newEvidenceId(),
        conversationId: q.conversationId,
        conductorRunId: (attempt.conductor_run_id as string) ?? q.runId,
        planId: (attempt.plan_id as string) ?? `plan_${q.runId}`,
        taskId: (attempt.task_id as string) ?? "unknown",
        attemptId: attempt.id as string,
        childRunId: (attempt.child_run_id as string) ?? q.runId,
        contextSnapshotId: (attempt.context_snapshot_id as string) ?? "",
        agentId: q.agentId,
      type: "user_answered",
      status: "valid",
      trustLevel: "authoritative",
      sourceKind: "user",
      sourceId: id,
      subjectType: "answer",
      subjectId: id,
        payloadJson: JSON.stringify({ questionExcerpt: firstQ.slice(0, 200), answerDigest: Object.values(answers).join(", ").slice(0, 500) }),
        contentHash: null,
        invalidatedAt: null,
        createdAt: now,
      });
    }
  } catch { /* evidence best-effort */ }

  store.delete(id);
  entry.resolver(answers);
  eventBus.publish({
    type: "ask_user.answered",
    conversationId: entry.question.conversationId,
    timestamp: Date.now(),
    pendingId: id,
    answers
  });
  return true;
}

export function cancelPendingQuestionsForRun(runId: string): void {
  const store = getStore();
  for (const [id, entry] of store) {
    if (entry.question.runId === runId) {
      cancelApproval(id, Date.now());
      store.delete(id);
      entry.resolver({});
      eventBus.publish({
        type: "ask_user.cancelled",
        conversationId: entry.question.conversationId,
        timestamp: Date.now(),
        pendingId: id,
        runId
      });
    }
  }
}

export function clearPendingQuestionsForTests(): void {
  const store = getStore();
  for (const [id, entry] of store) {
    resolveApproval(id, false, Date.now(), SYSTEM_RESOLVED_BY);
    entry.resolver({});
  }
  store.clear();
}
