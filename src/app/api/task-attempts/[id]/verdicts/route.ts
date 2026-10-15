import { getTaskAttempt, listCriterionVerdicts } from "@/server/repositories/evidence-repository";
import { gateRequest } from "@/server/api-gate";

export const dynamic = "force-dynamic";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const gate = await gateRequest(request);
  if (!gate.allowed) return gate.response;
  const { id } = await context.params;
  const attempt = getTaskAttempt(id);
  if (!attempt) {
    return Response.json({ error: "Task attempt not found." }, { status: 404 });
  }

  const rawVerdicts = listCriterionVerdicts(id);
  const verdicts = rawVerdicts.map((v) => {
    let evidenceIds: string[] = [];
    try {
      evidenceIds = JSON.parse(v.evidenceIdsJson);
    } catch { /* keep empty */ }

    return {
      id: v.id,
      criterionId: v.criterionId,
      validatorType: v.validatorType,
      status: v.status,
      evidenceIds,
      reason: v.reason,
      checkedAt: v.checkedAt,
    };
  });

  const passed = verdicts.filter((v) => v.status === "passed").length;
  const failed = verdicts.filter((v) => v.status === "failed").length;
  const needsReview = verdicts.filter((v) => v.status === "needs_review").length;
  const missing = verdicts.filter((v) => v.status === "missing").length;

  return Response.json({
    attemptId: id,
    summary: { passed, failed, needsReview, missing, total: verdicts.length },
    verdicts,
  });
}
