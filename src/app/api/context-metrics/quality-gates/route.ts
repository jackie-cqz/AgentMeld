import { runQualityGates } from "@/server/context-metrics/quality-gates";

export const dynamic = "force-dynamic";

export async function GET() {
  return Response.json(runQualityGates());
}
