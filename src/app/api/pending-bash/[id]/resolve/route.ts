import { z } from "zod";
import { approvePendingBash, getPendingBash, rejectPendingBash } from "@/server/pending-bash";
import { eventBus } from "@/server/event-bus";
import { conflictAlreadyResolved } from "@/server/api-utils";
import { getApprovalRecord, MAX_RESOLVED_BY_LENGTH } from "@/server/repositories";
import { gateRequest } from "@/server/api-gate";
import { describePrincipal } from "@/server/auth";

export const dynamic = "force-dynamic";

const resolveSchema = z.object({
  approved: z.boolean(),
  // Display label only. The identity recorded in `resolved_by` is derived from
  // the authenticated principal below. This boundary rejects an over-long label
  // (400) while normalizeResolvedByLabel truncates, because an internal caller
  // may hold a longer string than the HTTP contract allows.
  // Display label only. The identity recorded in `resolved_by` is derived from
  // the authenticated principal below — a caller cannot name itself into it.
  resolvedBy: z.string().trim().max(MAX_RESOLVED_BY_LENGTH).nullable().optional()
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

  // Identity from the session/device token, never from the body.
  const resolvedBy = describePrincipal(gate.principal);

  const entry = getPendingBash(id);
  if (!entry) {
    // Nothing is waiting in memory. If a resolved record of *this* type exists,
    // report who handled it: a concurrent double submit lands here too, since
    // the losing request finds the entry gone and would otherwise never reach
    // the 409 below. The type check keeps a resolved id from another queue from
    // being reported as this one's. A row still 'pending' with no in-memory
    // entry is inconsistent state, not a resolution, so it falls through to 404.
    const record = getApprovalRecord(id);
    if (record && record.approvalType === "bash" && record.status !== "pending") {
      return conflictAlreadyResolved("Pending bash command was already resolved.", record);
    }
    return Response.json({ error: "Pending bash command not found." }, { status: 404 });
  }

  if (parsed.data.approved) {
    if (!approvePendingBash(id, resolvedBy, parsed.data.resolvedBy)) {
      return conflictAlreadyResolved("Pending bash command was already resolved.", getApprovalRecord(id));
    }
    eventBus.publish({
      type: "bash_command.resolved",
      conversationId: entry.command.conversationId,
      timestamp: Date.now(),
      pendingId: id,
      approved: true
    });
    return Response.json({ resolved: true, approved: true });
  }

  if (!rejectPendingBash(id, resolvedBy, parsed.data.resolvedBy)) {
    return conflictAlreadyResolved("Pending bash command was already resolved.", getApprovalRecord(id));
  }
  eventBus.publish({
    type: "bash_command.resolved",
    conversationId: entry.command.conversationId,
    timestamp: Date.now(),
    pendingId: id,
    approved: false
  });
  return Response.json({ resolved: true, approved: false });
}
