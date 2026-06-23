import { withdrawMessage } from "@/server/message-mutation-service";

export const dynamic = "force-dynamic";

export async function POST(_request: Request, context: { params: Promise<{ id: string }> }) {
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
