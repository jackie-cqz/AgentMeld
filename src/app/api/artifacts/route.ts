import { z } from "zod";
import { announceArtifactCreated, getAllArtifacts, createNewArtifact } from "@/server/artifact-service";
import type { Artifact } from "@/shared/types";
import { gateRequest } from "@/server/api-gate";

export const dynamic = "force-dynamic";

const createArtifactSchema = z.object({
  conversationId: z.string().min(1),
  type: z.enum(["web_app", "document", "image", "ppt"]),
  title: z.string().min(1).max(200),
  content: z.unknown()
});

export async function GET(request: Request) {
  const gate = await gateRequest(request);
  if (!gate.allowed) return gate.response;
  const artifacts = getAllArtifacts();
  return Response.json({ artifacts });
}

export async function POST(request: Request) {
  const gate = await gateRequest(request);
  if (!gate.allowed) return gate.response;
  const body = await request.json().catch(() => ({}));
  const parsed = createArtifactSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  let created: Artifact | null = null;
  try {
    const artifact = createNewArtifact({
      conversationId: parsed.data.conversationId,
      type: parsed.data.type,
      title: parsed.data.title,
      content: parsed.data.content as never
    });
    created = artifact;
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Failed to create artifact." },
      { status: 400 }
    );
  }

  // Outside the try: the row is stored, and an event listener failing must not
  // be reported to the caller as a failed creation (it would retry, and the
  // retry would store a second artifact).
  if (created) announceArtifactCreated(created);
  return Response.json({ artifact: created }, { status: 201 });
}
