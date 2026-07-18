import { listBenchmarkRuns } from "@/server/context-metrics/benchmark-run-store";

export const dynamic = "force-dynamic";

export async function GET() {
  return Response.json({ runs: listBenchmarkRuns() });
}
