import { getPendingBashCommandsForConversation } from "@/server/pending-bash";

export const dynamic = "force-dynamic";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const commands = getPendingBashCommandsForConversation(id);
  return Response.json({ pendingBashCommands: commands });
}
