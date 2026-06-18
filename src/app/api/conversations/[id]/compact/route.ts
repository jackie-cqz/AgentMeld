import { getAgent, getConversation, listMessages, listArtifacts } from "@/server/repositories";
import { getContextBudgetPreview, runCompaction } from "@/server/conversation-context";
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

  const allMessages = listMessages(id).filter((m) => m.status === "complete");
  if (allMessages.length < 6) {
    return Response.json({
      compacted: false,
      reason: `消息太少（${allMessages.length} 条），至少需要 6 条。`
    });
  }

  // Skip pinned messages — they're important and should stay in context
  const pinnedIds = new Set(conversation.pinnedMessageIds ?? []);
  const compactable = allMessages.filter((m) => !pinnedIds.has(m.id));

  // Keep the last 8 messages; compress everything before that
  const keepRecent = Math.min(8, Math.max(2, compactable.length - 6));
  const sourceMessages = compactable.slice(0, compactable.length - keepRecent);

  if (sourceMessages.length < 3) {
    return Response.json({
      compacted: false,
      reason: "可压缩消息不足（需至少 3 条非置顶消息）。"
    });
  }

  // Get artifact titles for rendering
  const artifactTitles = new Map<string, string>();
  try {
    const artifacts = listArtifacts(id);
    for (const art of artifacts) {
      artifactTitles.set(art.id, art.title);
    }
  } catch {
    // proceed without artifact titles
  }

  // Serialize messages for the compaction prompt
  const rendered = sourceMessages.map((m) => {
    const text = m.parts
      .filter((p) => p.type === "text")
      .map((p) => p.content)
      .join(" ");
    const artifactRefs = m.parts
      .filter((p) => p.type === "artifact_ref")
      .map((p) => `[产物: ${artifactTitles.get(p.artifactId) ?? "unknown"} (${p.artifactId})]`);

    const content = [text, ...artifactRefs].filter(Boolean).join("\n");
    const agentName = m.agentId ? conversation.agentIds.includes(m.agentId) ? m.agentId : undefined : undefined;

    return {
      role: m.role,
      agentName,
      content: content.slice(0, 800)
    };
  }).filter((m) => m.content.length > 0);

  const lastSource = sourceMessages[sourceMessages.length - 1];
  const compactionAgent = conversation.agentIds
    .map((agentId) => getAgent(agentId))
    .find((agent) => agent?.adapterName === "custom" && agent.modelProvider === "deepseek")
    ?? conversation.agentIds
      .map((agentId) => getAgent(agentId))
      .find((agent) => agent?.adapterName === "custom");

  // Run compaction asynchronously — return 202 immediately
  const compactionPromise = runCompaction(
    id,
    rendered,
    lastSource.id,
    lastSource.createdAt,
    sourceMessages.length,
    compactionAgent?.modelProvider ?? "deepseek",
    compactionAgent?.modelId ?? "deepseek-chat",
    compactionAgent?.apiKey,
    compactionAgent?.apiBaseUrl
  );

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
    coveredUntilMessageId: lastSource.id
  });
}
