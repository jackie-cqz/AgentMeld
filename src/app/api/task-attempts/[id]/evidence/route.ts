import { getTaskAttempt, listEvidenceForAttempt } from "@/server/repositories/evidence-repository";
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

  const records = listEvidenceForAttempt(id);

  // Sanitise: return evidence summaries, NOT full payloads.
  // Full payloads available via read_evidence tool (gated by conversation scope).
  const items = records.map((ev) => {
    let payloadSummary: Record<string, unknown> | null = null;
    try {
      const p = JSON.parse(ev.payloadJson);
      // Only surface safe fields — never command output, file contents, or secrets
      payloadSummary = {
        path: p.path ?? null,
        action: p.action ?? null,
        command: typeof p.command === "string" ? p.command.slice(0, 120) : null,
        exitCode: p.exitCode ?? null,
        outputKey: p.outputKey ?? null,
        artifactId: p.artifactId ?? null,
      };
    } catch { /* skip unparseable */ }

    return {
      id: ev.id,
      type: ev.type,
      status: ev.status,
      trustLevel: ev.trustLevel,
      sourceKind: ev.sourceKind,
      subjectType: ev.subjectType,
      subjectId: ev.subjectId,
      contentHash: ev.contentHash,
      payloadSummary,
      createdAt: ev.createdAt,
    };
  });

  return Response.json({
    attemptId: id,
    count: items.length,
    evidence: items,
  });
}
