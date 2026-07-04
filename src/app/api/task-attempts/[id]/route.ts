import { getTaskAttempt, listEvidenceForAttempt } from "@/server/repositories/evidence-repository";
import { getContextSnapshot } from "@/server/repositories/evidence-repository";

export const dynamic = "force-dynamic";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const attempt = getTaskAttempt(id);
  if (!attempt) {
    return Response.json({ error: "Task attempt not found." }, { status: 404 });
  }

  // Summary only — full evidence/context/verdicts via sub-routes
  const evidenceRecords = listEvidenceForAttempt(id);
  const evidenceCount = evidenceRecords.length;
  const evidenceByType: Record<string, number> = {};
  for (const ev of evidenceRecords) {
    evidenceByType[ev.type] = (evidenceByType[ev.type] ?? 0) + 1;
  }

  let contextSummary = null;
  if (attempt.contextSnapshotId) {
    const snapshot = getContextSnapshot(attempt.contextSnapshotId);
    if (snapshot) {
      contextSummary = {
        contextSnapshotId: snapshot.id,
        policyVersion: snapshot.policyVersion,
        tokenEstimate: snapshot.tokenEstimate,
        requiredTokenEstimate: snapshot.requiredTokenEstimate,
        omittedTokenEstimate: snapshot.omittedTokenEstimate,
        createdAt: snapshot.createdAt,
      };
    }
  }

  return Response.json({
    attempt: {
      id: attempt.id,
      conductorRunId: attempt.conductorRunId,
      planId: attempt.planId,
      planRevision: attempt.planRevision,
      taskId: attempt.taskId,
      agentId: attempt.agentId,
      childRunId: attempt.childRunId,
      attempt: attempt.attempt,
      contextSnapshotId: attempt.contextSnapshotId,
      executionStatus: attempt.executionStatus,
      verificationStatus: attempt.verificationStatus,
      startedAt: attempt.startedAt,
      finishedAt: attempt.finishedAt,
      createdAt: attempt.createdAt,
    },
    evidenceSummary: { count: evidenceCount, byType: evidenceByType },
    contextSummary,
  });
}
