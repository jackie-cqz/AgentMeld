import { abortCompactionJob, getCompactionJob, getCompactionJobController } from "@/server/context-compaction-service";
import { gateRequest } from "@/server/api-gate";

export const dynamic = "force-dynamic";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const gate = await gateRequest(request);
  if (!gate.allowed) return gate.response;
  const { id } = await context.params;
  const job = getCompactionJob(id);
  if (!job) {
    return Response.json({ error: "Job not found." }, { status: 404 });
  }
  if (job.status !== "queued" && job.status !== "running") {
    return Response.json({ error: `Job already ${job.status}.` }, { status: 400 });
  }

  const ctrl = getCompactionJobController(id);
  if (ctrl) ctrl.abort();
  abortCompactionJob(id, Date.now());

  return Response.json({ jobId: id, aborted: true });
}
