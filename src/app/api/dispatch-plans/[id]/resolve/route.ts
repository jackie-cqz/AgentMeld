import { z } from "zod";
import { approvePlan, getPendingPlan, rejectPlan, revisePlanWithFeedback } from "@/server/dispatch-plan-manager";
import { compileAndValidateDispatchPlan } from "@/server/dispatch-plan";
import { getApprovalRecord, getConversation, getAgent, MAX_RESOLVED_BY_LENGTH } from "@/server/repositories";
import { eventBus } from "@/server/event-bus";
import { conflictAlreadyResolved } from "@/server/api-utils";
import { gateRequest } from "@/server/api-gate";
import { describePrincipal } from "@/server/auth";

export const dynamic = "force-dynamic";

const resolveSchema = z.object({
  action: z.enum(["approve", "reject", "revise"]),
  feedback: z.string().optional(),
  // Display label only. `resolved_by` is filled from the authenticated
  // principal below; this string never becomes identity. Note the deliberate
  // split with the server side: this boundary rejects an over-long label (400)
  // while normalizeResolvedByLabel truncates, because an internal caller may
  // hold a longer identifier than the HTTP contract allows.
  resolvedBy: z.string().trim().max(MAX_RESOLVED_BY_LENGTH).nullable().optional(),
  plan: z.array(z.object({
    id: z.string().min(1),
    agentId: z.string().min(1),
    task: z.string().min(1),
    dependsOn: z.array(z.string()).default([]),
    title: z.string().optional(),
    prompt: z.string().optional(),
    inputs: z.array(z.object({
      fromTaskId: z.string().min(1),
      outputId: z.string().min(1),
      required: z.boolean().optional(),
      description: z.string().optional()
    })).optional(),
    expectedOutputs: z.array(z.object({
      id: z.string().min(1),
      type: z.enum(["web_app", "document", "image", "ppt"]),
      required: z.boolean().optional(),
      description: z.string().optional()
    })).optional(),
    acceptanceCriteria: z.array(z.string()).optional(),
    maxAttempts: z.number().int().min(1).max(5).optional(),
    targetPaths: z.array(z.string()).optional(),
    requiredCommands: z.array(z.object({
      command: z.string().min(1),
      timeoutMs: z.number().positive().optional()
    })).optional(),
    requiredEvidence: z.array(z.string()).optional()
  })).max(20).optional()
});

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const gate = await gateRequest(request);
  if (!gate.allowed) return gate.response;
  const { id } = await context.params;
  const body = await request.json().catch(() => ({}));
  const parsed = resolveSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const resolvedBy = describePrincipal(gate.principal);

  const entry = getPendingPlan(id);
  if (!entry) {
    // See the bash route: consult the record of this type so a second surface
    // learns who resolved it instead of getting an uninformative 404.
    const record = getApprovalRecord(id);
    if (record && record.approvalType === "dispatch_plan" && record.status !== "pending") {
      return conflictAlreadyResolved("Plan was already resolved.", record);
    }
    return Response.json({ error: "Pending plan not found." }, { status: 404 });
  }

  const { action, feedback } = parsed.data;

  if (action === "reject") {
    if (!rejectPlan(id, resolvedBy, parsed.data.resolvedBy)) {
      return conflictAlreadyResolved("Plan was already resolved.", getApprovalRecord(id));
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
    if (!revisePlanWithFeedback(id, effectiveFeedback, resolvedBy, parsed.data.resolvedBy)) {
      return conflictAlreadyResolved("Plan was already resolved.", getApprovalRecord(id));
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

  // Find the conductor agent in the conversation
  const availableAgents = conversation.agentIds;
  const conductorAgentId = availableAgents.find((aid) => {
    const agent = getAgent(aid);
    return agent?.isConductor;
  }) ?? availableAgents[0] ?? "";

  const submittedPlan = parsed.data.plan ?? entry.plan.plan;
  const validationResult = compileAndValidateDispatchPlan(
    submittedPlan.map((p) => ({
      id: p.id,
      agentId: p.agentId,
      task: p.task,
      dependsOn: p.dependsOn ?? [],
      inputs: p.inputs ?? [],
      expectedOutputs: p.expectedOutputs ?? [],
      acceptanceCriteria: p.acceptanceCriteria ?? [],
      maxAttempts: p.maxAttempts,
      targetPaths: p.targetPaths,
      requiredCommands: p.requiredCommands,
      requiredEvidence: p.requiredEvidence
    })),
    availableAgents,
    conductorAgentId
  );

  if (typeof validationResult === "string") {
    // Plan fails validation at approval gate — reject it
    if (!rejectPlan(id, resolvedBy, parsed.data.resolvedBy)) {
      return conflictAlreadyResolved("Plan was already resolved.", getApprovalRecord(id));
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
  if (!approvePlan(id, validationResult, resolvedBy, parsed.data.resolvedBy)) {
    return conflictAlreadyResolved("Plan was already resolved.", getApprovalRecord(id));
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
