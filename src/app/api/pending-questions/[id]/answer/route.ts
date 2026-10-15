import { z } from "zod";
import { answerQuestion, getPendingQuestion } from "@/server/pending-questions";
import { conflictAlreadyResolved } from "@/server/api-utils";
import { getApprovalRecord, MAX_RESOLVED_BY_LENGTH } from "@/server/repositories";
import { gateRequest } from "@/server/api-gate";

export const dynamic = "force-dynamic";

const answerSchema = z.object({
  answers: z.record(z.string(), z.string()),
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
  const parsed = answerSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const entry = getPendingQuestion(id);
  if (!entry) {
    // See the bash route: consult the record of this type so a second surface
    // learns who answered instead of getting an uninformative 404. The message
    // stays accurate for a cancellation or interruption too, because the status
    // it carries says which of those happened.
    const record = getApprovalRecord(id);
    if (record && record.approvalType === "ask_user" && record.status !== "pending") {
      return conflictAlreadyResolved("Pending question was already settled.", record);
    }
    return Response.json({ error: "Pending question not found." }, { status: 404 });
  }

  if (!answerQuestion(id, parsed.data.answers, parsed.data.resolvedBy)) {
    return conflictAlreadyResolved("Pending question was already settled.", getApprovalRecord(id));
  }
  return Response.json({ answered: true });
}
