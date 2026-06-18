import { nanoid } from "nanoid";
import { eventBus } from "@/server/event-bus";
import type { PendingDispatchPlan, DispatchPlanItem } from "@/shared/types";

type Resolver = (outcome: { approved: boolean; feedback?: string }) => void;

interface PlanEntry {
  plan: PendingDispatchPlan;
  resolver: Resolver;
}

declare global {
  var __agentConferencePendingPlans: Map<string, PlanEntry> | undefined;
}

function getStore(): Map<string, PlanEntry> {
  if (!globalThis.__agentConferencePendingPlans) {
    globalThis.__agentConferencePendingPlans = new Map();
  }
  return globalThis.__agentConferencePendingPlans;
}

export function registerPendingPlan(
  conversationId: string,
  runId: string,
  plan: DispatchPlanItem[]
): Promise<{ approved: boolean; feedback?: string }> {
  const store = getStore();
  const id = `dp_${nanoid(12)}`;

  return new Promise((resolve) => {
    const entry: PlanEntry = {
      plan: { id, conversationId, runId, plan, createdAt: Date.now() },
      resolver: (outcome) => {
        store.delete(id);
        resolve(outcome);
      }
    };
    store.set(id, entry);

    // Publish SSE event so UI shows the card
    eventBus.publish({
      type: "dispatch.plan.pending",
      conversationId,
      timestamp: Date.now(),
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

export function approvePlan(id: string): boolean {
  const entry = getStore().get(id);
  if (!entry) return false;
  entry.resolver({ approved: true });
  return true;
}

export function rejectPlan(id: string): boolean {
  const entry = getStore().get(id);
  if (!entry) return false;
  entry.resolver({ approved: false });
  return true;
}

export function revisePlanWithFeedback(id: string, feedback: string): boolean {
  const entry = getStore().get(id);
  if (!entry) return false;
  entry.resolver({ approved: true, feedback });
  return true;
}

export function cancelPendingPlansForRun(runId: string): void {
  const store = getStore();
  for (const [id, entry] of store) {
    if (entry.plan.runId === runId) {
      entry.resolver({ approved: false });
      store.delete(id);
    }
  }
}

export function clearPendingPlansForTests(): void {
  const store = getStore();
  for (const [, entry] of store) {
    entry.resolver({ approved: false });
  }
  store.clear();
}
