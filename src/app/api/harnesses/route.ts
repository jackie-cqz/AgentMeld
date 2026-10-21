import { gateRequest } from "@/server/api-gate";
import { listHarnessAvailability } from "@/server/harness/availability";

export const dynamic = "force-dynamic";

/**
 * Per-harness availability: registration plus the driver's own `doctor()`.
 *
 * A dedicated endpoint rather than `/api/bootstrap` because this is a process /
 * installation probe (`doctor()` inspects the installed CLI), not persisted
 * conversation state: it must stay out of the bootstrap snapshot that is loaded
 * once on every page open, and it mirrors the existing `/api/runtime/pi` shape.
 * `no-store` for the same reason — installing an engine must be visible on the
 * next check, not cached forever.
 */
export async function GET(request: Request) {
  const gate = await gateRequest(request);
  if (!gate.allowed) return gate.response;
  return Response.json(
    { harnesses: listHarnessAvailability() },
    { headers: { "Cache-Control": "no-store" } },
  );
}
