import { getPendingPlansForConversation } from "@/server/dispatch-plan-manager";
import { gateRequest } from "@/server/api-gate";

export const dynamic = "force-dynamic";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const gate = await gateRequest(request);
  if (!gate.allowed) return gate.response;
  const { id } = await context.params;
  const plans = getPendingPlansForConversation(id);
  return Response.json({ pendingDispatchPlans: plans });
}
