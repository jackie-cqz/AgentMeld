import { z } from "zod";
import {
  createNewArtifactVersion,
  getArtifactById,
  getArtifactVersionFamily
} from "@/server/artifact-service";
import type { ArtifactContent } from "@/shared/types";

export const dynamic = "force-dynamic";

const createVersionSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  content: z.unknown().optional()
});

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const artifact = getArtifactById(id);
  if (!artifact) {
    return Response.json({ error: "Artifact not found." }, { status: 404 });
  }
  const family = getArtifactVersionFamily(id);
  return Response.json({
    artifact,
    family,
    versions: family?.versions ?? [],
    currentId: family?.currentId ?? id,
    latestId: family?.latestId ?? id
  });
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const body = await request.json().catch(() => ({}));
  const parsed = createVersionSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const artifact = createNewArtifactVersion(id, {
    title: parsed.data.title,
    content: parsed.data.content as ArtifactContent | undefined
  });
  if (!artifact) {
    return Response.json({ error: "Artifact not found." }, { status: 404 });
  }

  return Response.json({ artifact }, { status: 201 });
}
