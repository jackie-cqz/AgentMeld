import { ok } from "@/server/api-utils";
import { getDeliveryHealth } from "@/server/channels/feishu/delivery";
import { gateRequest } from "@/server/api-gate";

export const dynamic = "force-dynamic";
// The record lives on `globalThis`, so this route has to be evaluated in the
// same Node realm as `instrumentation.ts`. In an edge realm it would answer an
// empty list, which reads as "nothing has failed".
export const runtime = "nodejs";

/**
 * Whether anything the channel sent actually went out.
 *
 * This exists because there is nowhere else to ask. A failed send was only a
 * `console.error`, and the platform cannot be queried for the truth: the scopes
 * a one-click app is granted cannot read group messages back, so there is no
 * delivery receipt to consult.
 *
 * Rows appear for every conversation an attempt was made for, not only the
 * failures — "nothing has ever failed" and "nothing has ever been tried" are
 * different answers, and a list of failures cannot tell them apart.
 */
export async function GET(request: Request) {
  const gate = await gateRequest(request);
  if (!gate.allowed) return gate.response;
  return ok({ delivery: getDeliveryHealth() });
}
