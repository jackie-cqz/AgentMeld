import { gateRequest } from "@/server/api-gate";
import { ensureDatabase } from "@/db/bootstrap";
import { getDatabase } from "@/db/client";
import { getCollaborationTurn } from "@/server/collaboration/turns";

export const dynamic = "force-dynamic";
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const gate = await gateRequest(request);
  if (!gate.allowed) return gate.response;
  ensureDatabase();
  const { id } = await context.params;
  const turn = getCollaborationTurn(id);
  if (!turn) return Response.json({ error: "Turn not found." }, { status: 404 });
  const snapshots = getDatabase().prepare("SELECT id,previous_snapshot_id AS previousSnapshotId,context_json AS context,created_at AS createdAt FROM collaboration_context_snapshots WHERE turn_id=? ORDER BY created_at,id").all(id);
  return Response.json({ turn, snapshots });
}
