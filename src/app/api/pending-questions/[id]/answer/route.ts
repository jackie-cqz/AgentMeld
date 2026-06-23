import { z } from "zod";
import { answerQuestion, getPendingQuestion } from "@/server/pending-questions";

export const dynamic = "force-dynamic";

const answerSchema = z.object({
  answers: z.record(z.string(), z.string())
});

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const body = await request.json().catch(() => ({}));
  const parsed = answerSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const entry = getPendingQuestion(id);
  if (!entry) {
    return Response.json({ error: "Pending question not found." }, { status: 404 });
  }

  if (!answerQuestion(id, parsed.data.answers)) {
    return Response.json({ error: "Pending question was already answered." }, { status: 409 });
  }
  return Response.json({ answered: true });
}
