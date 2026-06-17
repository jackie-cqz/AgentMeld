import { getPendingPlansForConversation } from "@/server/dispatch-plan-manager";

export const dynamic = "force-dynamic";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const plans = getPendingPlansForConversation(id);
  return Response.json({ pendingDispatchPlans: plans });
}
