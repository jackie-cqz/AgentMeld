import { nanoid } from "nanoid";
import { eventBus } from "@/server/event-bus";
import { cancelApproval, persistApproval, resolveApproval } from "@/server/repositories";
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

export function approvePlan(id: string, plan?: DispatchPlanItem[]): boolean {
  return resolvePlan(id, { approved: true, plan });
}

export function rejectPlan(id: string): boolean {
  return resolvePlan(id, { approved: false });
}

export function revisePlanWithFeedback(id: string, feedback: string): boolean {
  return resolvePlan(id, { approved: true, feedback });
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
    resolveApproval(id, false, Date.now());
    entry.resolver({ approved: false });
  }
  store.clear();
}

function resolvePlan(
  id: string,
  outcome: { approved: boolean; feedback?: string; plan?: DispatchPlanItem[] }
): boolean {
  const store = getStore();
  const entry = store.get(id);
  if (!entry) return false;
  const now = Date.now();
  if (!resolveApproval(id, outcome.approved, now)) return false;

  // P1: Record approval evidence — must use a real task_attempt row for FK
  const p = entry.plan;
  try {
    // Look up any task attempt for this conductor run
    const attempts = getDatabase()
      .prepare("SELECT id FROM task_attempts WHERE conductor_run_id = ? LIMIT 1")
      .all(p.runId) as Array<{ id: string }>;
    const attemptId = attempts[0]?.id;
    if (attemptId) {
      insertEvidence({
        id: newEvidenceId(),
        conversationId: p.conversationId,
        conductorRunId: p.runId,
        planId: `plan_${p.runId}`,
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
    }
  } catch { /* evidence best-effort */ }

  store.delete(id);
  entry.resolver(outcome);
  return true;
}
