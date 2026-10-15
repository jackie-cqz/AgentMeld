import { notFound, ok } from "@/server/api-utils";
import { getBindingSession } from "@/server/channels/feishu/binding";
import { gateRequest } from "@/server/api-gate";

export const dynamic = "force-dynamic";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const gate = await gateRequest(request);
  if (!gate.allowed) return gate.response;
  const { id } = await context.params;
  const session = getBindingSession(id);
  if (!session) return notFound("Binding session not found.");

  // A settled session may still be read here; the launcher URL is only returned
  // while the attempt is live, since it is useless once it has been used.
  return ok({ session });
}
