import { getCompactionJob, getActiveCompactionJob } from "@/server/context-compaction-service";

export const dynamic = "force-dynamic";

export async function POST(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const job = getCompactionJob(id);
  if (!job) {
    return Response.json({ error: "Job not found." }, { status: 404 });
  }
  if (job.status !== "failed" && job.status !== "aborted" && job.status !== "interrupted") {
    return Response.json({ error: `Cannot retry job in "${job.status}" state. Only failed/aborted/interrupted jobs can be retried.` }, { status: 400 });
  }
  if (!job.retryable) {
    return Response.json({ error: `Job is not retryable (category: ${job.errorCategory}).` }, { status: 400 });
  }

  // Check no active job for this conversation
  const active = getActiveCompactionJob(job.conversationId);
  if (active) {
    return Response.json({ error: `已有进行中的压缩任务（${active.id}）。` }, { status: 409 });
  }

  // Redirect to the conversation compact endpoint to create a new job
  return Response.json({
    retry: true,
    conversationId: job.conversationId,
    previousJobId: id,
    hint: `POST /api/conversations/${job.conversationId}/compact to start a new compaction.`
  });
}
