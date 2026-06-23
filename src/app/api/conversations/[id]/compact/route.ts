import { getConversation } from "@/server/repositories";
import { getContextBudgetPreview } from "@/server/conversation-context";
import {
  getActiveCompactionJob,
  listCompactionJobs
} from "@/server/context-compaction-service";
import { startConversationCompaction } from "@/server/context-compaction-runner";

export const dynamic = "force-dynamic";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const preview = getContextBudgetPreview(id);
  if (!preview) {
    return Response.json({ error: "Conversation not found." }, { status: 404 });
  }
  const activeJob = getActiveCompactionJob(id);
  const recentJobs = listCompactionJobs(id);
  return Response.json({ preview, activeJob, recentJobs });
}

export async function POST(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  if (!getConversation(id)) {
    return Response.json({ error: "Conversation not found." }, { status: 404 });
  }

  const result = startConversationCompaction(id);
  if (!result.ok) {
    return Response.json(
      {
        compacted: false,
        reason: result.reason,
        job: result.activeJob
      },
      { status: result.activeJob ? 409 : 400 }
    );
  }

  return Response.json({
    compacted: true,
    job: result.job,
    sourceMessageCount: result.sourceMessageCount,
    coveredUntilMessageId: result.coveredUntilMessageId
  }, { status: 202 });
}
