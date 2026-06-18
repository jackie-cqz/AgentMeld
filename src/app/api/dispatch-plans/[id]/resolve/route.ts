import { z } from "zod";
import { approvePlan, getPendingPlan, rejectPlan, revisePlanWithFeedback } from "@/server/dispatch-plan-manager";
import { eventBus } from "@/server/event-bus";

export const dynamic = "force-dynamic";

const resolveSchema = z.object({
  action: z.enum(["approve", "reject", "revise"]),
  feedback: z.string().optional()
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

  const { action, feedback } = parsed.data;

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

  if (action === "revise") {
    const effectiveFeedback = feedback?.trim() || "请调整计划。";
    revisePlanWithFeedback(id, effectiveFeedback);
    eventBus.publish({
      type: "dispatch.plan.resolved",
      conversationId: entry.plan.conversationId,
      timestamp: Date.now(),
      pendingId: id,
      runId: entry.plan.runId,
      approved: true,
      feedback: effectiveFeedback
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
