import { getBenchmarkRun } from "@/server/context-metrics/benchmark-run-store";
import { gateRequest } from "@/server/api-gate";

export const dynamic = "force-dynamic";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const gate = await gateRequest(request);
  if (!gate.allowed) return gate.response;
  const { id } = await context.params;
  const run = getBenchmarkRun(id);
  return run
    ? Response.json({ run })
    : Response.json({ error: "Benchmark run not found." }, { status: 404 });
}
