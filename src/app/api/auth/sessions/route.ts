import { gateRequest } from "@/server/api-gate";
import { listSessions } from "@/server/auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Which devices hold a live owner session. No tokens — only ids and times. */
export async function GET(request: Request) {
  const gate = await gateRequest(request);
  if (!gate.allowed) return gate.response;

  return Response.json({ sessions: listSessions() });
}
