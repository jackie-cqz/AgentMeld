import { gateRequest } from "@/server/api-gate";
import { getPiDoctor } from "@/server/pi/config";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const gate = await gateRequest(request);
  if (!gate.allowed) return gate.response;
  return Response.json(getPiDoctor(), { headers: { "Cache-Control": "no-store" } });
}
