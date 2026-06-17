import { getPendingQuestionsForConversation } from "@/server/pending-questions";

export const dynamic = "force-dynamic";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const questions = getPendingQuestionsForConversation(id);
  return Response.json({ pendingQuestions: questions });
}
