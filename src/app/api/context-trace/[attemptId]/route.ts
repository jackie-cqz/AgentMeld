import { getContextTraceByAttempt } from "@/server/context-trace/context-trace-service";

export const dynamic = "force-dynamic";

export async function GET(_request: Request, context: { params: Promise<{ attemptId: string }> }) {
  const { attemptId } = await context.params;
  const result = getContextTraceByAttempt(attemptId);

  if ("error" in result) {
    return Response.json({ error: result.error }, { status: result.status });
  }

  return Response.json(result);
}
