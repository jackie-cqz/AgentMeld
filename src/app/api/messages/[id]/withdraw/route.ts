import { withdrawMessage } from "@/server/message-mutation-service";
import { gateRequest } from "@/server/api-gate";

export const dynamic = "force-dynamic";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const gate = await gateRequest(request);
  if (!gate.allowed) return gate.response;
  const { id } = await context.params;
  try {
    const result = withdrawMessage(id);
    return Response.json({
      deletedMessageIds: result.deletedMessageIds,
      deletedArtifactIds: result.deletedArtifactIds
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Withdraw failed.";
    return Response.json({ error: message }, { status: message === "Message not found." ? 404 : 400 });
  }
}
