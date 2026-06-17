import { z } from "zod";
import { approvePlan, getPendingPlan, rejectPlan, revisePlan } from "@/server/dispatch-plan-manager";
import { eventBus } from "@/server/event-bus";
import type { DispatchPlanItem } from "@/shared/types";

export const dynamic = "force-dynamic";

const resolveSchema = z.object({
  action: z.enum(["approve", "reject", "revise"]),
  revisedPlan: z
    .array(
      z.object({
        id: z.string(),
        agentId: z.string(),
        task: z.string(),
        dependsOn: z.array(z.string())
      })
    )
    .optional()
});

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const body = await request.json().catch(() => ({}));
  const parsed = resolveSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const entry = getPendingPlan(id);
  if (!entry) {
    return Response.json({ error: "Pending plan not found." }, { status: 404 });
  }

  const { action, revisedPlan } = parsed.data;

  if (action === "reject") {
    rejectPlan(id);
    eventBus.publish({
      type: "dispatch.plan.resolved",
      conversationId: entry.plan.conversationId,
      timestamp: Date.now(),
      pendingId: id,
      runId: entry.plan.runId,
      approved: false
    });
    return Response.json({ resolved: true, approved: false });
  }

  if (action === "revise" && revisedPlan) {
    revisePlan(id, revisedPlan as DispatchPlanItem[]);
    eventBus.publish({
      type: "dispatch.plan.resolved",
      conversationId: entry.plan.conversationId,
      timestamp: Date.now(),
      pendingId: id,
      runId: entry.plan.runId,
      approved: true
    });
    return Response.json({ resolved: true, approved: true, revised: true });
  }

  // approve
  approvePlan(id);
  eventBus.publish({
    type: "dispatch.plan.resolved",
    conversationId: entry.plan.conversationId,
    timestamp: Date.now(),
    pendingId: id,
    runId: entry.plan.runId,
    approved: true
  });
  return Response.json({ resolved: true, approved: true });
}
