import { z } from "zod";
import { badRequest } from "@/server/api-utils";
import { gateRequest } from "@/server/api-gate";
import { bindFeishuWithCredentials } from "@/server/channels/feishu/binding";

export const dynamic = "force-dynamic";

const manualSchema = z.object({
  agentId: z.string().min(1),
  appId: z.string().min(1),
  appSecret: z.string().min(1),
  tenantBrand: z.string().min(1).optional()
});

/**
 * Bind a Feishu app from credentials a person typed, instead of a QR scan.
 *
 * The answer carries a one-time claim code, and the binding it creates has NO
 * owner until that code is sent to the bot in the group: the credentials say
 * nothing about which human owns the bot, and every card action is authorised
 * against that human's open id. Until then the binding is fail-closed.
 *
 * The secret is never echoed back — the response carries the binding without it
 * (see `listFeishuBindings`).
 */
export async function POST(request: Request) {
  const gate = await gateRequest(request);
  if (!gate.allowed) return gate.response;

  const body = await request.json().catch(() => ({}));
  const parsed = manualSchema.safeParse(body);
  if (!parsed.success) {
    return badRequest("agentId, appId and appSecret are required.", parsed.error.flatten());
  }

  const result = await bindFeishuWithCredentials(parsed.data);
  if (!result.ok) {
    return Response.json({ error: result.error }, { status: result.status });
  }
  return Response.json({ binding: result.binding, claim: result.claim }, { status: 201 });
}
