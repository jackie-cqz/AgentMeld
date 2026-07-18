import { getBenchmarkRun } from "@/server/context-metrics/benchmark-run-store";

export const dynamic = "force-dynamic";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const run = getBenchmarkRun(id);
  return run
    ? Response.json({ run })
    : Response.json({ error: "Benchmark run not found." }, { status: 404 });
}
