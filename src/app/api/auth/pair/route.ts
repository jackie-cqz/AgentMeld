import { z } from "zod";
import { badRequest } from "@/server/api-utils";
import { redeemPairingCode } from "@/server/auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const redeemSchema = z.object({ code: z.string().min(1) });

/**
 * Redeem a pairing code into an owner session cookie. Reachable anonymously
 * during the bootstrap window (that is its whole job: the FIRST session has
 * to come from somewhere). After pairing, a code alone is no longer enough —
 * `gateRequest` requires a session/token before this route runs, so a leaked
 * code post-pairing cannot mint a second session without already being
 * inside. The code is single-use and attempt-capped at the auth layer.
 */
export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  const parsed = redeemSchema.safeParse(body);
  if (!parsed.success) return badRequest("A pairing code is required.");
  const result = redeemPairingCode(parsed.data.code);
  if (!result.ok) {
    return Response.json({ error: result.error ?? "Pairing failed." }, { status: result.status });
  }
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { "content-type": "application/json", "set-cookie": result.setCookie ?? "" }
  });
}
