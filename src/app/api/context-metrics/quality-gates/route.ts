import { runQualityGates } from "@/server/context-metrics/quality-gates";
import { gateRequest } from "@/server/api-gate";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const gate = await gateRequest(request);
  if (!gate.allowed) return gate.response;
  return Response.json(runQualityGates());
}
