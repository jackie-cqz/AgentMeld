import { abortRun, isRunActive } from "@/server/agent-runner";
import { gateRequest } from "@/server/api-gate";

export const dynamic = "force-dynamic";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const gate = await gateRequest(request);
  if (!gate.allowed) return gate.response;
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
