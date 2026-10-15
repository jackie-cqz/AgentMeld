import { z } from "zod";
import {
  getArtifactById,
  createNewArtifactVersion,
  getVersionChain
} from "@/server/artifact-service";
import { getDatabase } from "@/db/client";
import type { ArtifactContent } from "@/shared/types";
import { gateRequest } from "@/server/api-gate";
import { eventBus } from "@/server/event-bus";

export const dynamic = "force-dynamic";

const patchArtifactSchema = z.object({
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

  const versions = getVersionChain(id);

  return Response.json({ artifact, versions });
}

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const gate = await gateRequest(request);
  if (!gate.allowed) return gate.response;
  const { id } = await context.params;
  const body = await request.json().catch(() => ({}));
  const parsed = patchArtifactSchema.safeParse(body);
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
  eventBus.publish({
    type: "artifact.create",
    conversationId: artifact.conversationId,
    timestamp: Date.now(),
    artifact
  });
  return Response.json({ artifact });
}

export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  const gate = await gateRequest(request);
  if (!gate.allowed) return gate.response;
  const { id } = await context.params;
  const existing = getArtifactById(id);
  if (!existing) {
    return Response.json({ error: "Artifact not found." }, { status: 404 });
  }

  // Delete from DB
  const db = getDatabase();
  db.prepare("DELETE FROM artifacts WHERE id = ?").run(id);
  return new Response(null, { status: 204 });
}
