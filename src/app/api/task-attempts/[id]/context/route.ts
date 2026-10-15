import { getTaskAttempt, getContextSnapshot } from "@/server/repositories/evidence-repository";
import type { ContextManifestItem } from "@/shared/task-context-types";
import { gateRequest } from "@/server/api-gate";

export const dynamic = "force-dynamic";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const gate = await gateRequest(request);
  if (!gate.allowed) return gate.response;
  const { id } = await context.params;
  const attempt = getTaskAttempt(id);
  if (!attempt) {
    return Response.json({ error: "Task attempt not found." }, { status: 404 });
  }

  if (!attempt.contextSnapshotId) {
    return Response.json({ error: "No context snapshot for this attempt." }, { status: 404 });
  }

  const snapshot = getContextSnapshot(attempt.contextSnapshotId);
  if (!snapshot) {
    return Response.json({ error: "Context snapshot not found." }, { status: 404 });
  }

  let manifest: ContextManifestItem[] = [];
  try {
    manifest = JSON.parse(snapshot.manifestJson);
  } catch { /* return raw json */ }

  const included = manifest.filter((m) => m.included);
  const omitted = manifest.filter((m) => !m.included);

  // Sanitise: strip envelope_json (too large for API), return structured view
  return Response.json({
    snapshotId: snapshot.id,
    attemptId: id,
    policyVersion: snapshot.policyVersion,
    schemaVersion: snapshot.schemaVersion,
    budget: {
      tokenEstimate: snapshot.tokenEstimate,
      requiredTokens: snapshot.requiredTokenEstimate,
      omittedTokens: snapshot.omittedTokenEstimate,
    },
    manifest: {
      included: included.map((m) => ({
        category: m.category,
        sourceType: m.sourceType,
        sourceId: m.sourceId,
        reason: m.reason,
        trustLevel: m.trustLevel,
        tokenEstimate: m.tokenEstimate,
        required: m.required,
      })),
      omitted: omitted.map((m) => ({
        category: m.category,
        sourceType: m.sourceType,
        sourceId: m.sourceId,
        omittedReason: m.omittedReason,
        tokenEstimate: m.tokenEstimate,
      })),
    },
    createdAt: snapshot.createdAt,
  });
}
