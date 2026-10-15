import { createPairingCode } from "@/server/auth";
import { gateRequest } from "@/server/api-gate";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Ask for a pairing code.
 *
 * During the bootstrap window (no owner paired yet) this is reachable
 * anonymously — that is how the FIRST session gets created, and a fresh
 * install is expected to sit on loopback. Once an owner exists the gate
 * requires that owner's session before a new code can be minted: code
 * generation is a privileged act, only its REDEMPTION is open (see
 * /api/auth/pair).
 */
export async function POST(request: Request) {
  const gate = await gateRequest(request);
  if (!gate.allowed) return gate.response;

  const { code, expiresAt } = createPairingCode();
  return Response.json({ code, expiresAt });
}
