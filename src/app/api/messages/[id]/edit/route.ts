import { z } from "zod";
import { editMessage } from "@/server/message-mutation-service";

export const dynamic = "force-dynamic";

const editSchema = z.object({
  content: z.string().trim().min(1).max(8000)
});

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const body = await request.json().catch(() => ({}));
  const parsed = editSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  try {
    const result = await editMessage(id, parsed.data.content);
    return Response.json(result, { status: 202 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Edit failed.";
    return Response.json({ error: message }, { status: message === "Message not found." ? 404 : 400 });
  }
}
