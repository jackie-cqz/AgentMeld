import { getAgent, getConversation } from "@/server/repositories";
import { getContextBudgetPreview, runCompaction } from "@/server/conversation-context";
import {
  selectCompactionWindow, serializeMessageForCompaction, chunkCompactionMessages, getArtifactTitleMap,
  createCompactionJob, startCompactionJob, completeCompactionJob, failCompactionJob,
  abortCompactionJob, getActiveCompactionJob, getCompactionJob, listCompactionJobs,
  setCompactionJobController, removeCompactionJobController, updateCompactionJobProgress,
  type CompactionJob
} from "@/server/context-compaction-service";
import { eventBus } from "@/server/event-bus";
import { newMessageId, newContextSummaryId } from "@/shared/ids";
import { getDatabase } from "@/db/client";

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
  const now = Date.now();

  const conversation = getConversation(id);
  if (!conversation) {
    return Response.json({ error: "Conversation not found." }, { status: 404 });
  }

  // P1: Check for existing active job
  const existingJob = getActiveCompactionJob(id);
  if (existingJob) {
    return Response.json({ job: existingJob, compacted: false, reason: "已有进行中的压缩任务。" });
  }

  const window = selectCompactionWindow(id);
  if (window.blockingReason) {
    return Response.json({ compacted: false, reason: window.blockingReason });
  }

  const { sourceMessages, coveredUntilMessageId, coveredUntilCreatedAt } = window;
  const artifactTitles = getArtifactTitleMap(id);
  const { chunks } = chunkCompactionMessages(sourceMessages, artifactTitles);

  const compactionAgent = conversation.agentIds
    .map((agentId) => getAgent(agentId))
    .find((agent) => agent?.adapterName === "custom" && agent.modelProvider === "deepseek")
    ?? conversation.agentIds.map((agentId) => getAgent(agentId)).find((agent) => agent?.adapterName === "custom");
  const provider = compactionAgent?.modelProvider ?? "deepseek";
  const model = compactionAgent?.modelId ?? "deepseek-chat";

  // P1: Create persistent job
  const jobId = `ccj_${newMessageId()}`;
  const jobResult = createCompactionJob(jobId, id, chunks[0]?.startMessageId ?? coveredUntilMessageId, coveredUntilMessageId, sourceMessages.length, chunks.length, provider, model, now);
  if (typeof jobResult === "string") {
    return Response.json({ compacted: false, reason: jobResult });
  }

  const serializedChunks = chunks.map((c) => ({
    messages: c.messages.map((m) => ({
      role: m.role, agentName: m.agentId && conversation.agentIds.includes(m.agentId) ? m.agentId : undefined,
      content: serializeMessageForCompaction(m, artifactTitles)
    })).filter((m) => m.content.length > 0),
    startMessageId: c.startMessageId, endMessageId: c.endMessageId, estimatedTokens: c.estimatedTokens
  }));

  // P1: Abort controller for cancellation
  const abortCtrl = new AbortController();
  setCompactionJobController(jobId, abortCtrl);

  // P1: Execute in background with job state updates
  const compactionPromise = (async () => {
    startCompactionJob(jobId, Date.now());

    try {
      eventBus.publish({ type: "compaction.start", conversationId: id, timestamp: Date.now(), sourceMessageCount: sourceMessages.length });

      let rollingSummary: string | null = null;
      for (let i = 0; i < serializedChunks.length; i++) {
        if (abortCtrl.signal.aborted) throw Object.assign(new Error("Compaction aborted."), { category: "aborted" });
        const chunk = serializedChunks[i];
        const isLast = i === serializedChunks.length - 1;
        const result = await runCompaction(id, chunk.messages,
          isLast ? coveredUntilMessageId : chunk.endMessageId,
          isLast ? coveredUntilCreatedAt : sourceMessages.find((m) => m.id === chunk.endMessageId)?.createdAt ?? coveredUntilCreatedAt,
          sourceMessages.length, provider, model, compactionAgent?.apiKey, compactionAgent?.apiBaseUrl,
          rollingSummary, !isLast, abortCtrl.signal, true);
        rollingSummary = result.summary;
        if (!isLast) updateCompactionJobProgress(jobId, i + 1, Date.now());
      }

      completeCompactionJob(jobId, "summary_ref", Date.now());
      removeCompactionJobController(jobId);
      postSystemMessage(id, `上下文压缩完成：${sourceMessages.length} 条消息 → 约 ${Math.ceil((rollingSummary?.length ?? 0) / 4)} tokens。`);
      return { summary: rollingSummary!, tokenEstimate: Math.ceil((rollingSummary?.length ?? 0) / 4) };
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      const category = (err as { category?: string }).category ?? "provider_server";
      const retryable = category === "provider_rate_limit" || category === "provider_timeout" || category === "provider_server";
      failCompactionJob(jobId, category, msg.slice(0, 500), retryable, Date.now());
      removeCompactionJobController(jobId);
      postSystemMessage(id, `上下文压缩失败：${msg.slice(0, 200)}`);
      throw err;
    }
  })();

  // Don't await — return job immediately
  return Response.json({ compacted: true, job: jobResult, sourceMessageCount: sourceMessages.length, coveredUntilMessageId }, { status: 202 });
}

function postSystemMessage(conversationId: string, content: string) {
  const now = Date.now();
  const msgId = newMessageId();
  getDatabase().prepare(`INSERT INTO messages (id, conversation_id, role, agent_id, run_id, parts, status, mentioned_agent_ids, parent_message_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(msgId, conversationId, "system", null, null, JSON.stringify([{ type: "text", content }]), "complete", JSON.stringify([]), null, now, now);
  eventBus.publish({ type: "message.added", conversationId, timestamp: now, message: { id: msgId, conversationId, role: "system", agentId: null, runId: null, parts: [{ type: "text", content }], status: "complete", parentMessageId: null, mentionedAgentIds: [], createdAt: now, updatedAt: now } });
}

function updateCompactionJobProgress(jobId: string, completedChunks: number, now: number) {
  // imported from context-compaction-service
}
