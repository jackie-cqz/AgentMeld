import { getContextTraceByAttempt } from "@/server/context-trace/context-trace-service";
import { gateRequest } from "@/server/api-gate";

export const dynamic = "force-dynamic";

export async function GET(request: Request, context: { params: Promise<{ attemptId: string }> }) {
  const gate = await gateRequest(request);
  if (!gate.allowed) return gate.response;
  const { attemptId } = await context.params;
  const result = getContextTraceByAttempt(attemptId);

  if ("error" in result) {
    return Response.json({ error: result.error }, { status: result.status });
  }

  return Response.json(result);
}
