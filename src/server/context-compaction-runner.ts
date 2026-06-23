import { getDatabase } from "@/db/client";
import { runCompaction } from "@/server/conversation-context";
import {
  abortCompactionJob,
  chunkCompactionMessages,
  completeCompactionJob,
  createCompactionJob,
  failCompactionJob,
  getActiveCompactionJob,
  getArtifactTitleMap,
  getLatestSummary,
  removeCompactionJobController,
  selectCompactionWindow,
  serializeMessageForCompaction,
  setCompactionJobController,
  startCompactionJob,
  updateCompactionJobProgress,
  type CompactionJob
} from "@/server/context-compaction-service";
import { eventBus } from "@/server/event-bus";
import { getAgent, getConversation } from "@/server/repositories";
import { newMessageId } from "@/shared/ids";

export type StartCompactionResult =
  | {
      ok: true;
      job: CompactionJob;
      sourceMessageCount: number;
      coveredUntilMessageId: string;
    }
  | {
      ok: false;
      reason: string;
      activeJob?: CompactionJob;
    };

export function startConversationCompaction(
  conversationId: string,
  options?: { previousJob?: CompactionJob }
): StartCompactionResult {
  const conversation = getConversation(conversationId);
  if (!conversation) {
    return { ok: false, reason: "Conversation not found." };
  }

  const activeJob = getActiveCompactionJob(conversationId);
  if (activeJob) {
    return { ok: false, reason: "已有进行中的压缩任务。", activeJob };
  }

  const window = selectCompactionWindow(conversationId);
  if (window.blockingReason) {
    return { ok: false, reason: window.blockingReason };
  }

  const { sourceMessages, coveredUntilMessageId, coveredUntilCreatedAt } = window;
  const artifactTitles = getArtifactTitleMap(conversationId);
  const { chunks } = chunkCompactionMessages(sourceMessages, artifactTitles);
  if (chunks.length === 0) {
    return { ok: false, reason: "No messages to compact." };
  }

  const compactionAgent = conversation.agentIds
    .map((agentId) => getAgent(agentId))
    .find((agent) => agent?.adapterName === "custom" && agent.modelProvider === "deepseek")
    ?? conversation.agentIds
      .map((agentId) => getAgent(agentId))
      .find((agent) => agent?.adapterName === "custom");

  const provider = compactionAgent?.modelProvider ?? "deepseek";
  const model = compactionAgent?.modelId ?? "deepseek-chat";
  const now = Date.now();
  const latestSummary = getLatestSummary(conversationId);
  const jobId = `ccj_${newMessageId()}`;
  const created = createCompactionJob(
    jobId,
    conversationId,
    chunks[0].startMessageId,
    coveredUntilMessageId,
    sourceMessages.length,
    chunks.length,
    provider,
    model,
    now,
    {
      baseSummaryId: latestSummary?.id ?? null,
      previousJobId: options?.previousJob?.id ?? null,
      attempt: options?.previousJob ? options.previousJob.attempt + 1 : 1
    }
  );

  if (typeof created === "string") {
    return { ok: false, reason: created };
  }

  const serializedChunks = chunks.map((chunk) => ({
    messages: chunk.messages
      .map((message) => ({
        role: message.role,
        agentName: message.agentId && conversation.agentIds.includes(message.agentId)
          ? message.agentId
          : undefined,
        content: serializeMessageForCompaction(message, artifactTitles)
      }))
      .filter((message) => message.content.length > 0),
    endMessageId: chunk.endMessageId
  }));

  const abortController = new AbortController();
  setCompactionJobController(jobId, abortController);
  void executeCompactionJob({
    jobId,
    conversationId,
    sourceMessages,
    sourceMessageCount: sourceMessages.length,
    coveredUntilMessageId,
    coveredUntilCreatedAt,
    serializedChunks,
    provider,
    model,
    apiKey: compactionAgent?.apiKey,
    apiBaseUrl: compactionAgent?.apiBaseUrl,
    abortController
  });

  return {
    ok: true,
    job: created,
    sourceMessageCount: sourceMessages.length,
    coveredUntilMessageId
  };
}

interface ExecuteCompactionJobInput {
  jobId: string;
  conversationId: string;
  sourceMessages: ReturnType<typeof selectCompactionWindow>["sourceMessages"];
  sourceMessageCount: number;
  coveredUntilMessageId: string;
  coveredUntilCreatedAt: number;
  serializedChunks: Array<{
    messages: Array<{ role: string; agentName?: string; content: string }>;
    endMessageId: string;
  }>;
  provider: string;
  model: string;
  apiKey?: string | null;
  apiBaseUrl?: string | null;
  abortController: AbortController;
}

async function executeCompactionJob(input: ExecuteCompactionJobInput): Promise<void> {
  const {
    jobId,
    conversationId,
    sourceMessages,
    sourceMessageCount,
    coveredUntilMessageId,
    coveredUntilCreatedAt,
    serializedChunks,
    provider,
    model,
    apiKey,
    apiBaseUrl,
    abortController
  } = input;

  if (!startCompactionJob(jobId, Date.now())) {
    removeCompactionJobController(jobId);
    return;
  }

  try {
    eventBus.publish({
      type: "compaction.start",
      conversationId,
      timestamp: Date.now(),
      sourceMessageCount
    });

    let rollingSummary: string | null = null;
    let resultSummaryId: string | null = null;

    for (let index = 0; index < serializedChunks.length; index++) {
      if (abortController.signal.aborted) {
        throw Object.assign(new Error("Compaction aborted."), { category: "aborted" });
      }

      const chunk = serializedChunks[index];
      const isLast = index === serializedChunks.length - 1;
      const result = await runCompaction(
        conversationId,
        chunk.messages,
        isLast ? coveredUntilMessageId : chunk.endMessageId,
        isLast
          ? coveredUntilCreatedAt
          : sourceMessages.find((message) => message.id === chunk.endMessageId)?.createdAt
            ?? coveredUntilCreatedAt,
        sourceMessageCount,
        provider,
        model,
        apiKey,
        apiBaseUrl,
        rollingSummary,
        !isLast,
        abortController.signal,
        true
      );

      rollingSummary = result.summary;
      resultSummaryId = result.summaryId;
      if (!isLast) {
        updateCompactionJobProgress(jobId, index + 1, Date.now());
      }
    }

    if (!resultSummaryId) {
      throw new Error("Compaction completed without a persisted summary id.");
    }

    completeCompactionJob(jobId, resultSummaryId, Date.now());
    postSystemMessage(
      conversationId,
      `上下文压缩完成：${sourceMessageCount} 条消息 → 约 ${Math.ceil((rollingSummary?.length ?? 0) / 4)} tokens。`
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    const category = (error as { category?: string }).category ?? "provider_server";

    if (abortController.signal.aborted || category === "aborted") {
      abortCompactionJob(jobId, Date.now());
      postSystemMessage(conversationId, "上下文压缩已中止。");
    } else {
      const retryable = category === "provider_rate_limit"
        || category === "provider_timeout"
        || category === "provider_server";
      failCompactionJob(jobId, category, message.slice(0, 500), retryable, Date.now());
      postSystemMessage(conversationId, `上下文压缩失败：${message.slice(0, 200)}`);
    }
  } finally {
    removeCompactionJobController(jobId);
  }
}

function postSystemMessage(conversationId: string, content: string): void {
  const now = Date.now();
  const messageId = newMessageId();
  const parts = [{ type: "text" as const, content }];

  getDatabase().prepare(`
    INSERT INTO messages (
      id, conversation_id, role, agent_id, run_id, parts, status,
      mentioned_agent_ids, parent_message_id, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    messageId,
    conversationId,
    "system",
    null,
    null,
    JSON.stringify(parts),
    "complete",
    JSON.stringify([]),
    null,
    now,
    now
  );

  eventBus.publish({
    type: "message.added",
    conversationId,
    timestamp: now,
    message: {
      id: messageId,
      conversationId,
      role: "system",
      agentId: null,
      runId: null,
      parts,
      status: "complete",
      parentMessageId: null,
      mentionedAgentIds: [],
      createdAt: now,
      updatedAt: now
    }
  });
}
