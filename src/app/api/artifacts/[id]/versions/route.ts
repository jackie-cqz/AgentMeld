import { z } from "zod";
import {
  createNewArtifactVersion,
  getArtifactById,
  getArtifactVersionFamily
} from "@/server/artifact-service";
import type { ArtifactContent } from "@/shared/types";
import { gateRequest } from "@/server/api-gate";
import { announceArtifactCreated } from "@/server/artifact-service";

export const dynamic = "force-dynamic";

const createVersionSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  content: z.unknown().optional()
});

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const gate = await gateRequest(request);
  if (!gate.allowed) return gate.response;
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
  const gate = await gateRequest(request);
  if (!gate.allowed) return gate.response;
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

  // A new version is a NEW row (new id, version + 1), so this is the same event
  // the create path publishes — and the room gets the new content rather than
  // nothing at all.
  announceArtifactCreated(artifact);
  return Response.json({ artifact }, { status: 201 });
}
