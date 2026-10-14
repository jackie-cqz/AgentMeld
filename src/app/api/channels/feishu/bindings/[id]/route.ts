import { notFound, ok } from "@/server/api-utils";
import { unbindAgent } from "@/server/channels/feishu/binding";
import { listChannelBindings } from "@/server/repositories";

export const dynamic = "force-dynamic";

/**
 * Remove a local binding. The Feishu-side app is NOT deleted — there is no
 * confirmed API for that — so callers should tell the user the app remains.
 */
export async function DELETE(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const binding = listChannelBindings().find((item) => item.id === id);
  if (!binding) return notFound("Channel binding not found.");

  if (!unbindAgent(binding.agentId)) return notFound("Channel binding not found.");
  return ok({ removed: binding.id, appLeftBehind: binding.appId });
}
