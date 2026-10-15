import { nanoid } from "nanoid";
import { eventBus } from "@/server/event-bus";
import { cancelApproval, getRun, persistApproval, resolveApproval, SYSTEM_RESOLVED_BY } from "@/server/repositories";
import { insertEvidence } from "@/server/repositories/evidence-repository";
import { getDatabase } from "@/db/client";
import { newEvidenceId } from "@/shared/ids";
import type { PendingDispatchPlan, DispatchPlanItem } from "@/shared/types";

type Resolver = (outcome: { approved: boolean; feedback?: string; plan?: DispatchPlanItem[] }) => void;

interface PlanEntry {
  plan: PendingDispatchPlan;
  resolver: Resolver;
}

declare global {
  var __agentMeldPendingPlans: Map<string, PlanEntry> | undefined;
}

function getStore(): Map<string, PlanEntry> {
  if (!globalThis.__agentMeldPendingPlans) {
    globalThis.__agentMeldPendingPlans = new Map();
  }
  return globalThis.__agentMeldPendingPlans;
}

export function registerPendingPlan(
  conversationId: string,
  runId: string,
  plan: DispatchPlanItem[]
): Promise<{ approved: boolean; feedback?: string; plan?: DispatchPlanItem[] }> {
  const store = getStore();
  const id = `dp_${nanoid(12)}`;
  const now = Date.now();

  // P2: Persist to DB
  persistApproval({
    id, conversationId, agentId: plan[0]?.agentId ?? "", runId,
    approvalType: "dispatch_plan",
    payloadJson: JSON.stringify(plan.slice(0, 10)),
    now
  });

  return new Promise((resolve) => {
    const entry: PlanEntry = {
      plan: { id, conversationId, runId, plan, createdAt: now },
      resolver: (outcome) => {
        resolve(outcome);
      }
    };
    store.set(id, entry);

    eventBus.publish({
      type: "dispatch.plan.pending",
      conversationId,
      timestamp: now,
      pendingPlan: entry.plan
    });
  });
}

export function getPendingPlan(id: string): PlanEntry | undefined {
  return getStore().get(id);
}

export function getAllPendingPlans(): PendingDispatchPlan[] {
  return Array.from(getStore().values()).map((e) => e.plan);
}

export function getPendingPlansForConversation(conversationId: string): PendingDispatchPlan[] {
  return getAllPendingPlans().filter((p) => p.conversationId === conversationId);
}

export function approvePlan(
  id: string,
  plan?: DispatchPlanItem[],
  resolvedBy?: string | null,
  resolvedByLabel?: string | null
): boolean {
  return resolvePlan(id, { approved: true, plan, resolvedBy, resolvedByLabel });
}

export function rejectPlan(
  id: string,
  resolvedBy?: string | null,
  resolvedByLabel?: string | null
): boolean {
  return resolvePlan(id, { approved: false, resolvedBy, resolvedByLabel });
}

export function revisePlanWithFeedback(
  id: string,
  feedback: string,
  resolvedBy?: string | null,
  resolvedByLabel?: string | null
): boolean {
  return resolvePlan(id, { approved: true, feedback, resolvedBy, resolvedByLabel });
}

export function cancelPendingPlansForRun(runId: string): void {
  const store = getStore();
  for (const [id, entry] of store) {
    if (entry.plan.runId === runId) {
      cancelApproval(id, Date.now());
      store.delete(id);
      entry.resolver({ approved: false });
      eventBus.publish({
        type: "dispatch.plan.resolved",
        conversationId: entry.plan.conversationId,
        timestamp: Date.now(),
        pendingId: id,
        runId,
        approved: false
      });
    }
  }
}

export function clearPendingPlansForTests(): void {
  const store = getStore();
  for (const [id, entry] of store) {
    resolveApproval(id, false, Date.now(), SYSTEM_RESOLVED_BY);
    entry.resolver({ approved: false });
  }
  store.clear();
}

function resolvePlan(
  id: string,
  outcome: {
    approved: boolean;
    feedback?: string;
    plan?: DispatchPlanItem[];
    resolvedBy?: string | null;
    resolvedByLabel?: string | null;
  }
): boolean {
  const store = getStore();
  const entry = store.get(id);
  if (!entry) return false;
  const now = Date.now();

  // A plan is only meaningful while the run that produced it is alive. A
  // restart (or any failure) leaves its card sitting in a room, and approving
  // it later accepted the approval and then delegated nothing: the delegation
  // gate refused with "only a running run may delegate", the conductor counted
  // that as a failed task and answered with a recovery plan — which walked into
  // the same wall, forever. Settle the stale card instead of pretending.
  const sourceRun = getRun(entry.plan.runId);
  // Only a run we can SEE and that has ended is conclusive. A plan whose run
  // row is missing cannot be judged here (the tests drive this store stand-
  // alone, and a missing row is not evidence of a dead run), so it keeps the
  // old behaviour rather than being refused on a guess.
  if (sourceRun && sourceRun.status !== "running") {
    cancelApproval(id, now);
    store.delete(id);
    entry.resolver({ approved: false });
    eventBus.publish({
      type: "dispatch.plan.resolved",
      conversationId: entry.plan.conversationId,
      timestamp: now,
      pendingId: id,
      runId: entry.plan.runId,
      approved: false
    });
    return false;
  }

  if (!resolveApproval(id, outcome.approved, now, outcome.resolvedBy ?? null, outcome.resolvedByLabel ?? null)) return false;

  // P1: Record approval evidence — use real planId from conductor_plans table
  const p = entry.plan;
  try {
    const db = getDatabase();
    // Look up the real planId for this conductor run (may be _init, _rev1, etc.)
    const planRow = db.prepare("SELECT id, revision FROM conductor_plans WHERE conductor_run_id = ? ORDER BY revision DESC LIMIT 1").get(p.runId) as { id: string; revision: number } | undefined;
    const realPlanId = planRow?.id ?? `plan_${p.runId}_init`;
    const planRevision = planRow?.revision ?? 0;

    // Look up or create a conductor meta-attempt for THIS plan revision.
    //
    // The row exists so the approval evidence below has an attempt to hang off.
    // It has to end terminal here: nothing else ever finishes it, and leaving it
    // 'running' made every approved plan report a permanently running attempt.
    //
    // Upsert rather than INSERT OR IGNORE, because `pending-questions.ts` creates
    // the same row id first (as 'running') when the Conductor asks a clarifying
    // question during the plan stage. With IGNORE that insert wins and the row
    // stays running forever — for exactly the plans that asked a question.
    // `reported_complete` is this column's success token (see finishTaskAttempt);
    // `verification_status` stays 'not_started' because no verdicts exist for it.
    const attemptId = `ta_conductor_${realPlanId}`;
    db.prepare(`
      INSERT INTO task_attempts (id, conductor_run_id, conversation_id, plan_id, plan_revision, task_id, agent_id, attempt, execution_status, verification_status, started_at, finished_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'conductor', 'conductor', 0, 'reported_complete', 'not_started', ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        execution_status = 'reported_complete',
        finished_at = COALESCE(task_attempts.finished_at, excluded.finished_at),
        updated_at = excluded.updated_at
    `).run(attemptId, p.runId, p.conversationId, realPlanId, planRevision, now, now, now, now);
    insertEvidence({
        id: newEvidenceId(),
        conversationId: p.conversationId,
        conductorRunId: p.runId,
        planId: realPlanId,
        taskId: "conductor",
        attemptId,
        childRunId: p.runId,
        contextSnapshotId: "conductor_approval",
        agentId: "conductor",
        type: "approval_resolved",
        status: "valid",
        trustLevel: "authoritative",
        sourceKind: "system",
        sourceId: id,
        subjectType: "approval",
        subjectId: id,
        payloadJson: JSON.stringify({ approved: outcome.approved, feedback: outcome.feedback ?? null }),
        contentHash: null,
        invalidatedAt: null,
        createdAt: now,
      });
  } catch { /* evidence best-effort */ }

  store.delete(id);
  entry.resolver(outcome);
  return true;
}
