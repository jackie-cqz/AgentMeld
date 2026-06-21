import { getCompactionJob } from "@/server/context-compaction-service";
import { startConversationCompaction } from "@/server/context-compaction-runner";

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

  const result = startConversationCompaction(job.conversationId, { previousJob: job });
  if (!result.ok) {
    return Response.json(
      {
        error: result.reason,
        activeJob: result.activeJob
      },
      { status: result.activeJob ? 409 : 400 }
    );
  }

  return Response.json({
    retry: true,
    previousJobId: id,
    job: result.job
  }, { status: 202 });
}
