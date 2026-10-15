import { hasPairedOwner } from "@/server/auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * The one route every caller can reach without a session — including during
 * the bootstrap window — because it answers exactly one question: is there an
 * owner to authenticate as? The frontend uses it to decide whether to render
 * the pairing screen or the app. It leaks nothing beyond that boolean.
 */
export async function GET() {
  return Response.json({ paired: hasPairedOwner() });
}
