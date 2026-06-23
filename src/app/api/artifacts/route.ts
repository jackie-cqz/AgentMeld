import { z } from "zod";
import { getAllArtifacts, createNewArtifact } from "@/server/artifact-service";

export const dynamic = "force-dynamic";

const createArtifactSchema = z.object({
  conversationId: z.string().min(1),
  type: z.enum(["web_app", "document", "image", "ppt"]),
  title: z.string().min(1).max(200),
  content: z.unknown()
});

export async function GET() {
  const artifacts = getAllArtifacts();
  return Response.json({ artifacts });
}

export async function POST(request: Request) {
  const body = await request.json().catch(() => ({}));
  const parsed = createArtifactSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  try {
    const artifact = createNewArtifact({
      conversationId: parsed.data.conversationId,
      type: parsed.data.type,
      title: parsed.data.title,
      content: parsed.data.content as never
    });
    return Response.json({ artifact }, { status: 201 });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Failed to create artifact." },
      { status: 400 }
    );
  }
}
