import { getAgent, getConversation } from "@/server/repositories";
import { getContextBudgetPreview, runCompaction } from "@/server/conversation-context";
import { selectCompactionWindow, serializeMessageForCompaction, chunkCompactionMessages, getArtifactTitleMap } from "@/server/context-compaction-service";
import { eventBus } from "@/server/event-bus";
import { newMessageId } from "@/shared/ids";
import { getDatabase } from "@/db/client";

export const dynamic = "force-dynamic";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const preview = getContextBudgetPreview(id);
  if (!preview) {
    return Response.json({ error: "Conversation not found." }, { status: 404 });
  }
  return Response.json({ preview });
}

export async function POST(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;

  const conversation = getConversation(id);
  if (!conversation) {
    return Response.json({ error: "Conversation not found." }, { status: 404 });
  }

  // P0: Use selectCompactionWindow for boundary-correct selection
  const window = selectCompactionWindow(id);
  if (window.blockingReason) {
    return Response.json({ compacted: false, reason: window.blockingReason });
  }

  const { sourceMessages, coveredUntilMessageId, coveredUntilCreatedAt } = window;
  const artifactTitles = getArtifactTitleMap(id);

  // P2: Full serialization (no 800-char truncation) + chunk into ~10K token groups
  const { chunks } = chunkCompactionMessages(sourceMessages, artifactTitles);
  const serializedChunks = chunks.map((c) => ({
    messages: c.messages.map((m) => ({
      role: m.role,
      agentName: m.agentId && conversation.agentIds.includes(m.agentId) ? m.agentId : undefined,
      content: serializeMessageForCompaction(m, artifactTitles)
    })).filter((m) => m.content.length > 0),
    startMessageId: c.startMessageId,
    endMessageId: c.endMessageId,
    estimatedTokens: c.estimatedTokens
  }));

  const compactionAgent = conversation.agentIds
    .map((agentId) => getAgent(agentId))
    .find((agent) => agent?.adapterName === "custom" && agent.modelProvider === "deepseek")
    ?? conversation.agentIds
      .map((agentId) => getAgent(agentId))
      .find((agent) => agent?.adapterName === "custom");

  // P2: Rolling summary — process chunks sequentially with shared abort signal
  const abortSignal = new AbortController();
  const compactionPromise = (async () => {
    const provider = compactionAgent?.modelProvider ?? "deepseek";
    const model = compactionAgent?.modelId ?? "deepseek-chat";
    const key = compactionAgent?.apiKey;
    const url = compactionAgent?.apiBaseUrl;

    // Publish single start event (not per-chunk)
    eventBus.publish({ type: "compaction.start", conversationId: id, timestamp: Date.now(), sourceMessageCount: sourceMessages.length });

    if (serializedChunks.length <= 1) {
      const msgs = serializedChunks.length === 1 ? serializedChunks[0].messages : [];
      if (msgs.length === 0) throw new Error("No messages to compact.");
      if (abortSignal.signal.aborted) throw new Error("Compaction aborted.");
      return runCompaction(id, msgs, coveredUntilMessageId, coveredUntilCreatedAt, sourceMessages.length, provider, model, key, url, undefined, false, abortSignal.signal);
    }

    // Multi-chunk: rolling — intermediate chunks skip start events and DB store
    let rollingSummary: string | null = null;
    for (let i = 0; i < serializedChunks.length; i++) {
      if (abortSignal.signal.aborted) throw new Error("Compaction aborted.");
      const chunk = serializedChunks[i];
      const isLast = i === serializedChunks.length - 1;
      const result = await runCompaction(
        id, chunk.messages,
        isLast ? coveredUntilMessageId : chunk.endMessageId,
        isLast ? coveredUntilCreatedAt : sourceMessages.find((m) => m.id === chunk.endMessageId)?.createdAt ?? coveredUntilCreatedAt,
        sourceMessages.length, provider, model, key, url,
        rollingSummary, !isLast, abortSignal.signal, !isLast
      );
      rollingSummary = result.summary;
    }
    return { summary: rollingSummary!, tokenEstimate: Math.ceil((rollingSummary?.length ?? 0) / 4) };
  })();
  // Store the controller for cancellation
  (compactionPromise as unknown as { _abort: AbortController })._abort = abortSignal;

  // Post a system message noting compaction has started
  const now = Date.now();
  const systemMsgId = newMessageId();
  getDatabase().prepare(`
    INSERT INTO messages (id, conversation_id, role, agent_id, run_id, parts, status, mentioned_agent_ids, parent_message_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    systemMsgId, id, "system", null, null,
    JSON.stringify([{ type: "text", content: `正在压缩上下文（${sourceMessages.length} 条早期消息）...` }]),
    "complete", JSON.stringify([]), null, now, now
  );

  eventBus.publish({
    type: "message.added",
    conversationId: id,
    timestamp: now,
    message: {
      id: systemMsgId,
      conversationId: id,
      role: "system",
      agentId: null,
      runId: null,
      parts: [{ type: "text", content: `正在压缩上下文（${sourceMessages.length} 条早期消息）...` }],
      status: "complete",
      parentMessageId: null,
      mentionedAgentIds: [],
      createdAt: now,
      updatedAt: now
    }
  });

  // Wait for compaction in background — don't block response
  compactionPromise
    .then((result) => {
      const doneTime = Date.now();
      const doneMsgId = newMessageId();
      const content = `上下文压缩完成：${sourceMessages.length} 条消息生成约 ${result.tokenEstimate} token 摘要。后续对话将自动引用此摘要。`;

      getDatabase().prepare(`
        INSERT INTO messages (id, conversation_id, role, agent_id, run_id, parts, status, mentioned_agent_ids, parent_message_id, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        doneMsgId, id, "system", null, null,
        JSON.stringify([{ type: "text", content }]),
        "complete", JSON.stringify([]), null, doneTime, doneTime
      );

      eventBus.publish({
        type: "message.added",
        conversationId: id,
        timestamp: doneTime,
        message: {
          id: doneMsgId,
          conversationId: id,
          role: "system",
          agentId: null,
          runId: null,
          parts: [{ type: "text", content }],
          status: "complete",
          parentMessageId: null,
          mentionedAgentIds: [],
          createdAt: doneTime,
          updatedAt: doneTime
        }
      });
    })
    .catch((err) => {
      const errTime = Date.now();
      const errMsgId = newMessageId();
      const content = `上下文压缩失败：${err instanceof Error ? err.message.slice(0, 200) : "未知错误"}`;

      getDatabase().prepare(`
        INSERT INTO messages (id, conversation_id, role, agent_id, run_id, parts, status, mentioned_agent_ids, parent_message_id, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        errMsgId, id, "system", null, null,
        JSON.stringify([{ type: "text", content }]),
        "complete", JSON.stringify([]), null, errTime, errTime
      );

      eventBus.publish({
        type: "message.added",
        conversationId: id,
        timestamp: errTime,
        message: {
          id: errMsgId,
          conversationId: id,
          role: "system",
          agentId: null,
          runId: null,
          parts: [{ type: "text", content }],
          status: "complete",
          parentMessageId: null,
          mentionedAgentIds: [],
          createdAt: errTime,
          updatedAt: errTime
        }
      });
    });

  return Response.json({
    compacted: true,
    sourceMessageCount: sourceMessages.length,
    coveredUntilMessageId: coveredUntilMessageId
  });
}
