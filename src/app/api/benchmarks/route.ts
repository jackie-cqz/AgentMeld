import { listBenchmarkRuns } from "@/server/context-metrics/benchmark-run-store";
import { gateRequest } from "@/server/api-gate";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const gate = await gateRequest(request);
  if (!gate.allowed) return gate.response;
  return Response.json({ runs: listBenchmarkRuns() });
}
