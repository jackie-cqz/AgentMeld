import { z } from "zod";
import { approvePlan, getPendingPlan, rejectPlan, revisePlanWithFeedback } from "@/server/dispatch-plan-manager";
import { compileAndValidateDispatchPlan } from "@/server/dispatch-plan";
import { getConversation, getAgent } from "@/server/repositories";
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
    if (!rejectPlan(id)) {
      return Response.json({ error: "Plan was already resolved." }, { status: 409 });
    }
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
    if (!revisePlanWithFeedback(id, effectiveFeedback)) {
      return Response.json({ error: "Plan was already resolved." }, { status: 409 });
    }
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

  // ── Layer 3: Approval gate — re-validate plan before executing ──
  const conversation = getConversation(entry.plan.conversationId);
  if (!conversation) {
    return Response.json({ error: "Conversation not found." }, { status: 404 });
  }

  // Find the orchestrator agent in the conversation
  const availableAgents = conversation.agentIds;
  const orchestratorAgentId = availableAgents.find((aid) => {
    const agent = getAgent(aid);
    return agent?.isOrchestrator;
  }) ?? availableAgents[0] ?? "";

  const validationResult = compileAndValidateDispatchPlan(
    entry.plan.plan.map((p) => ({
      id: p.id,
      agentId: p.agentId,
      task: p.task,
      dependsOn: p.dependsOn ?? [],
      inputs: p.inputs ?? [],
      expectedOutputs: p.expectedOutputs ?? [],
      acceptanceCriteria: p.acceptanceCriteria ?? []
    })),
    availableAgents,
    orchestratorAgentId
  );

  if (typeof validationResult === "string") {
    // Plan fails validation at approval gate — reject it
    if (!rejectPlan(id)) {
      return Response.json({ error: "Plan was already resolved." }, { status: 409 });
    }
    eventBus.publish({
      type: "dispatch.plan.resolved",
      conversationId: entry.plan.conversationId,
      timestamp: Date.now(),
      pendingId: id,
      runId: entry.plan.runId,
      approved: false
    });
    return Response.json({
      resolved: true,
      approved: false,
      error: `Plan validation failed at approval gate: ${validationResult}`
    });
  }

  // Plan validated — approve
  if (!approvePlan(id)) {
    return Response.json({ error: "Plan was already resolved." }, { status: 409 });
  }
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
