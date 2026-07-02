import { z } from "zod";
import { deployConversationArtifact } from "@/server/conversation-service";

export const dynamic = "force-dynamic";

const deploySchema = z.object({
  artifactId: z.string().min(1)
});

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const body = await request.json().catch(() => ({}));
  const parsed = deploySchema.safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  try {
    const result = await deployConversationArtifact(id, parsed.data.artifactId);
    return Response.json(result);
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Deployment failed." },
      { status: 400 }
    );
  }
}
