import { notFound } from "@/server/api-utils";
import { gateRequest } from "@/server/api-gate";
import { revokeSession } from "@/server/auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Revoke one owner session. The revoked session's cookie dies on its next
 * request; the browser keeps the cookie but it resolves to anonymous.
 */
export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  const gate = await gateRequest(request);
  if (!gate.allowed) return gate.response;

  const { id } = await context.params;
  if (!revokeSession(id)) return notFound("No such live session.");
  return Response.json({ ok: true });
}
