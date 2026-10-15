import { getDatabase } from "@/db/client";
import { getContextTraceByAttempt } from "@/server/context-trace/context-trace-service";
import { gateRequest } from "@/server/api-gate";

export const dynamic = "force-dynamic";

/** Look up a task attempt by child run ID and redirect to its context trace. */
export async function GET(request: Request, context: { params: Promise<{ childRunId: string }> }) {
  const gate = await gateRequest(request);
  if (!gate.allowed) return gate.response;
  const { childRunId } = await context.params;

  const db = getDatabase();
  const row = db
    .prepare("SELECT id FROM task_attempts WHERE child_run_id = ? ORDER BY attempt DESC LIMIT 1")
    .get(childRunId) as { id: string } | undefined;

  if (!row) {
    return Response.json({ error: "No task attempt found for this child run." }, { status: 404 });
  }

  const result = getContextTraceByAttempt(row.id);
  return Response.json(result);
}
