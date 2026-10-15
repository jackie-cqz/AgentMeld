import { notFound, ok } from "@/server/api-utils";
import { listFeishuBindings, unbindAgent } from "@/server/channels/feishu/binding";
import { gateRequest } from "@/server/api-gate";

export const dynamic = "force-dynamic";

/**
 * Remove a local binding. The Feishu-side app is NOT deleted — there is no
 * confirmed API for that — so callers should tell the user the app remains.
 */
export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  const gate = await gateRequest(request);
  if (!gate.allowed) return gate.response;
  const { id } = await context.params;
  // Through the service, not the repository: this read needs the database to
  // exist, and reaching the repository directly skipped that on a fresh one.
  const binding = listFeishuBindings().find((item) => item.id === id);
  if (!binding) return notFound("Channel binding not found.");

  if (!unbindAgent(binding.agentId)) return notFound("Channel binding not found.");
  return ok({ removed: binding.id, appLeftBehind: binding.appId });
}
