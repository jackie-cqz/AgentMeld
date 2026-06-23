import { abortRun, isRunActive } from "@/server/agent-runner";

export const dynamic = "force-dynamic";

export async function POST(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;

  if (!isRunActive(id)) {
    return Response.json({ error: "Run not found or already completed." }, { status: 404 });
  }

  const aborted = abortRun(id);
  if (!aborted) {
    return Response.json({ error: "Failed to abort run." }, { status: 500 });
  }

  return Response.json({ runId: id, aborted: true });
}
