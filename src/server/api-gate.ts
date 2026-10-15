import { resolvePrincipal, hasPairedOwner, type AuthPrincipal } from "@/server/auth";

/**
 * The route-side half of the #24 gate: one line a route adds to become
 * protected. Fail-closed — anything the resolver cannot vouch for is
 * anonymous, and anonymous is refused once an owner has paired.
 *
 * Which anonymous requests survive, and why:
 *
 * - `/api/auth/status` — answers one boolean ("is there an owner?"). The
 *   frontend needs it to decide between the pairing screen and the app.
 * - `/api/auth/pair` — code redemption. A NEW device has no credentials by
 *   definition; the single-use, 5-minute, attempt-capped code IS the secret
 *   being presented. Reachable anonymously at all times on purpose.
 * - `/api/auth/pair/code` — code MINTING. Only during the bootstrap window
 *   (no owner yet, fresh install): the first session has to come from
 *   somewhere, and a fresh install is expected to sit on loopback. Once an
 *   owner exists, minting requires that owner's session — so a leaked code
 *   cannot be quietly replaced by whoever leaked it.
 *
 * The window itself: before the first pairing there is no secret in the
 * database to check against, so locking everything would lock the owner out
 * of their own fresh install. Everything else answers 503 until the first
 * code is redeemed.
 */

export type GateOutcome =
  | { allowed: true; response: undefined; principal: AuthPrincipal }
  | { allowed: false; response: Response; principal: AuthPrincipal };

function deny(status: number, error: string, wwwAuthenticate?: string): Response {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (wwwAuthenticate) headers["www-authenticate"] = wwwAuthenticate;
  return new Response(JSON.stringify({ error }), { status, headers });
}

export async function gateRequest(request: Request): Promise<GateOutcome> {
  const principal = await resolvePrincipal(request);
  if (principal.kind !== "anonymous") return { allowed: true, response: undefined, principal };

  const url = new URL(request.url);
  if (url.pathname === "/api/auth/status" || url.pathname === "/api/auth/pair") {
    return { allowed: true, response: undefined, principal };
  }

  if (!hasPairedOwner()) {
    if (url.pathname === "/api/auth/pair/code") {
      return { allowed: true, response: undefined, principal };
    }
    return {
      allowed: false,
      principal,
      response: deny(503, "Not paired yet. Open the app on the machine running AgentMeld to pair.")
    };
  }

  return {
    allowed: false,
    principal,
    response: deny(401, "Authentication required.", 'Bearer realm="agentmeld"')
  };
}
