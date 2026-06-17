import { nanoid } from "nanoid";
import { eventBus } from "@/server/event-bus";
import type { PendingDispatchPlan, DispatchPlanItem } from "@/shared/types";

type Resolver = (approved: boolean, revisedPlan?: DispatchPlanItem[]) => void;

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
): Promise<{ approved: boolean; revisedPlan?: DispatchPlanItem[] }> {
  const store = getStore();
  const id = `dp_${nanoid(12)}`;

  return new Promise((resolve) => {
    const entry: PlanEntry = {
      plan: { id, conversationId, runId, plan, createdAt: Date.now() },
      resolver: (approved, revisedPlan) => {
        store.delete(id);
        resolve({ approved, revisedPlan });
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
  entry.resolver(true);
  return true;
}

export function rejectPlan(id: string): boolean {
  const entry = getStore().get(id);
  if (!entry) return false;
  entry.resolver(false);
  return true;
}

export function revisePlan(id: string, revisedPlan: DispatchPlanItem[]): boolean {
  const entry = getStore().get(id);
  if (!entry) return false;
  entry.resolver(true, revisedPlan);
  return true;
}

export function cancelPendingPlansForRun(runId: string): void {
  const store = getStore();
  for (const [id, entry] of store) {
    if (entry.plan.runId === runId) {
      entry.resolver(false);
      store.delete(id);
    }
  }
}

export function clearPendingPlansForTests(): void {
  const store = getStore();
  for (const [, entry] of store) {
    entry.resolver(false);
  }
  store.clear();
}
