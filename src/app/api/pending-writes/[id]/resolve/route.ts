import { z } from "zod";
import { approvePendingWrite, getPendingWrite, rejectPendingWrite } from "@/server/pending-writes";
import { eventBus } from "@/server/event-bus";
import { conflictAlreadyResolved } from "@/server/api-utils";
import { getApprovalRecord, MAX_RESOLVED_BY_LENGTH } from "@/server/repositories";
import { gateRequest } from "@/server/api-gate";
import { describePrincipal } from "@/server/auth";

export const dynamic = "force-dynamic";

const resolveSchema = z.object({
  approved: z.boolean(),
  // Caller-declared attribution label (not authenticated). Omit it, or send
  // null, when the operator is unknown. Note the deliberate split with the
  // server side: this boundary rejects an over-long label (400) while
  // normalizeResolvedBy truncates, because an internal caller may hold a
  // longer identifier than the HTTP contract allows.
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

  const resolvedBy = describePrincipal(gate.principal);

  const entry = getPendingWrite(id);
  if (!entry) {
    // See the bash route: consult the record of this type so a second surface
    // learns who handled it instead of getting an uninformative 404.
    const record = getApprovalRecord(id);
    if (record && record.approvalType === "fs_write" && record.status !== "pending") {
      return conflictAlreadyResolved("Pending write was already resolved.", record);
    }
    return Response.json({ error: "Pending write not found." }, { status: 404 });
  }

  if (parsed.data.approved) {
    if (!approvePendingWrite(id, resolvedBy, parsed.data.resolvedBy)) {
      return conflictAlreadyResolved("Pending write was already resolved.", getApprovalRecord(id));
    }
    eventBus.publish({
      type: "fs_write.resolved",
      conversationId: entry.write.conversationId,
      timestamp: Date.now(),
      pendingId: id,
      applied: true
    });
    return Response.json({ resolved: true, applied: true });
  }

  if (!rejectPendingWrite(id, resolvedBy, parsed.data.resolvedBy)) {
    return conflictAlreadyResolved("Pending write was already resolved.", getApprovalRecord(id));
  }
  eventBus.publish({
    type: "fs_write.resolved",
    conversationId: entry.write.conversationId,
    timestamp: Date.now(),
    pendingId: id,
    applied: false
  });
  return Response.json({ resolved: true, applied: false });
}
