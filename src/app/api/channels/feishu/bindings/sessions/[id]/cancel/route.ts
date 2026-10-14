import { notFound, ok } from "@/server/api-utils";
import { cancelBindingSession } from "@/server/channels/feishu/binding";

export const dynamic = "force-dynamic";

/**
 * Abort an in-flight scan. Cancelling an already-settled attempt is a no-op,
 * but the response reports the attempt's *actual* status, so a caller is never
 * told "cancelled" about a scan that already succeeded.
 */
export async function POST(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const session = cancelBindingSession(id);
  if (!session) return notFound("Binding session not found.");
  return ok({ session });
}
