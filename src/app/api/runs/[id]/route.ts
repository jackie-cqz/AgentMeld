import { getRun } from "@/server/repositories";
import { listConductorPlans, listOutputBindings, listConductorConflicts, listChildRunIds } from "@/server/repositories";
import { listCompactionJobs } from "@/server/context-compaction-service";

export const dynamic = "force-dynamic";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const run = getRun(id);
  if (!run) {
    return Response.json({ error: "Run not found." }, { status: 404 });
  }

  // Gather children
  const childIds = listChildRunIds(id);
  const children = childIds.map((cid) => {
    const child = getRun(cid);
    if (!child) return null;
    return {
      id: child.id, agentId: child.agentId, status: child.status,
      stage: child.stage, error: child.error, interrupted: child.interrupted,
      usage: child.usage, startedAt: child.startedAt, finishedAt: child.finishedAt
    };
  }).filter(Boolean);

  // Conductor details
  const plans = listConductorPlans(id).map((p) => ({
    id: p.id, revision: p.revision, status: p.status,
    userFeedback: p.user_feedback, stageAtCreation: p.stage_at_creation,
    resumedFromRunId: p.resumed_from_run_id, createdAt: p.created_at
  }));

  const bindings = listOutputBindings(`plan_${id}_init`).map((b) => ({
    producerTaskId: b.producer_task_id, outputKey: b.output_key,
    artifactId: b.artifact_id, createdAt: b.created_at
  }));

  const conflicts = listConductorConflicts(id).map((c) => ({
    path: c.path, wave: c.wave,
    contributors: JSON.parse(c.contributors_json as string),
    status: c.status, createdAt: c.created_at
  }));

  // Compaction jobs for this conversation
  const compactionJobs = listCompactionJobs(run.conversationId).slice(0, 5).map((j) => ({
    id: j.id, status: j.status, sourceMessageCount: j.sourceMessageCount,
    chunkCount: j.chunkCount, completedChunkCount: j.completedChunkCount,
    errorCategory: j.errorCategory, error: j.error,
    createdAt: j.createdAt, finishedAt: j.finishedAt
  }));

  return Response.json({
    run: {
      id: run.id, conversationId: run.conversationId, agentId: run.agentId,
      status: run.status, stage: run.stage, error: run.error,
      interrupted: run.interrupted, usage: run.usage,
      startedAt: run.startedAt, finishedAt: run.finishedAt,
      parentRunId: run.parentRunId, triggerMessageId: run.triggerMessageId,
      createdAt: run.createdAt, updatedAt: run.updatedAt
    },
    children,
    conductor: { plans, bindings, conflicts },
    compactionJobs
  });
}
