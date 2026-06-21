import { getConversation, listArtifacts, listMessages } from "@/server/repositories";
import { getDatabase } from "@/db/client";
import { eventBus } from "@/server/event-bus";
import { resolveApiKey, getSettings } from "@/server/settings-service";
import { estimateTokens } from "@/shared/token-estimate";
import { getLatestSummary, validateSummaryBoundary } from "@/server/context-compaction-service";
import { newContextSummaryId } from "@/shared/ids";
import type { Message, MessagePart } from "@/shared/types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_call_id?: string;
  name?: string;
}

export interface BuildHistoryOptions {
  maxTurns?: number;
  includePinned?: boolean;
  excludeMessageId?: string;
  tokenBudget?: number;
}

export interface ContextBudgetPreview {
  estimatedTokens: number;
  summaryIncluded: boolean;
  summaryTokens: number;
  pinnedMessageCount: number;
  recentMessageCount: number;
  omittedMessageCount: number;
  totalCompleteMessages: number;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function buildHistoryFor(
  agentId: string,
  conversationId: string,
  options?: BuildHistoryOptions
): Promise<ChatMessage[]> {
  const maxTurns = options?.maxTurns ?? 20;
  const includePinned = options?.includePinned ?? true;
  const excludeMessageId = options?.excludeMessageId;

  // 1. Read conversation + context summary
  const conversation = getConversation(conversationId);
  if (!conversation) return [];

  const isGroup = conversation.agentIds.length > 1;
  const summary = getLatestSummary(conversationId);

  // 2. Get recent complete messages (after summary covered range if exists)
  const allMessages = listMessages(conversationId).filter(
    (m) => m.status === "complete" && m.id !== excludeMessageId
  );

  // P0: Use messageId as primary boundary (not createdAt)
  const afterCovered = summary
    ? (() => {
        const coverIdx = allMessages.findIndex((m) => m.id === summary.coveredUntilMessageId);
        return coverIdx >= 0 ? allMessages.slice(coverIdx + 1) : allMessages;
      })()
    : allMessages;

  // 3. Split recent + pinned
  const pinnedIds = includePinned ? new Set(conversation.pinnedMessageIds) : new Set<string>();
  const recentMessages = afterCovered
    .filter((m) => !pinnedIds.has(m.id))
    .slice(-maxTurns);

  const pinnedMessages = includePinned
    ? allMessages.filter((m) => pinnedIds.has(m.id)) // pinned always from full range
    : [];

  // 4. Merge, dedupe, sort by createdAt
  const byId = new Map<string, Message>();
  for (const m of recentMessages) byId.set(m.id, m);
  for (const m of pinnedMessages) byId.set(m.id, m);
  const merged = Array.from(byId.values()).sort((a, b) => a.createdAt - b.createdAt);

  // 5. Get all artifact titles in one query
  const artifactIds = new Set<string>();
  for (const m of merged) {
    for (const p of m.parts) {
      if (p.type === "artifact_ref") artifactIds.add(p.artifactId);
    }
  }
  const artifactTitles = new Map<string, string>();
  if (artifactIds.size > 0) {
    const allArtifacts = listArtifacts(conversationId);
    for (const art of allArtifacts) {
      if (artifactIds.has(art.id)) {
        artifactTitles.set(art.id, art.title);
      }
    }
  }

  // 6. Serialize to ChatMessage[]
  const items: Array<{ pinned: boolean; messages: ChatMessage[]; tokens: number }> = [];
  for (const msg of merged) {
    const serialized = serializeMessage(msg, agentId, isGroup, artifactTitles);
    if (serialized.length === 0) continue;
    const tokens = serialized.reduce((sum, m) => sum + estimateTokens(m.content), 0);
    items.push({
      pinned: pinnedIds.has(msg.id),
      messages: serialized,
      tokens
    });
  }

  // 7. Token budget truncation
  const budget = options?.tokenBudget;
  if (budget !== undefined && budget >= 0) {
    let totalTokens = items.reduce((s, it) => s + it.tokens, 0);
    // Drop oldest non-pinned items first. budget=0 → drop all non-pinned.
    for (let i = 0; i < items.length && totalTokens > budget; i++) {
      if (items[i].pinned) continue;
      totalTokens -= items[i].tokens;
      items[i] = { ...items[i], tokens: -1 };
    }
  }

  // 8. Flatten — summary goes first, then history
  const result: ChatMessage[] = [];

  // Inject context summary as first user message (durable context)
  if (summary) {
    result.push({
      role: "user",
      content: `<conversation_summary covered_until="${summary.coveredUntilMessageId}">\n${summary.summary}\n</conversation_summary>`
    });
  }

  for (const item of items) {
    if (item.tokens < 0) continue;
    result.push(...item.messages);
  }

  return result;
}

export function getContextBudgetPreview(
  conversationId: string,
  maxTurns = 20
): ContextBudgetPreview | null {
  const conversation = getConversation(conversationId);
  if (!conversation) return null;

  const summary = getLatestContextSummary(conversationId);
  const messages = listMessages(conversationId).filter((message) => message.status === "complete");
  const pinnedIds = new Set(conversation.pinnedMessageIds);
  const pinnedMessages = messages.filter((message) => pinnedIds.has(message.id));
  // P0: Use messageId boundary, not createdAt
  const afterCovered = summary
    ? (() => {
        const coverIdx = messages.findIndex((m) => m.id === summary.coveredUntilMessageId);
        return coverIdx >= 0 ? messages.slice(coverIdx + 1) : messages;
      })()
    : messages;
  const recentMessages = afterCovered
    .filter((message) => !pinnedIds.has(message.id))
    .slice(-maxTurns);

  const includedIds = new Set([
    ...pinnedMessages.map((message) => message.id),
    ...recentMessages.map((message) => message.id)
  ]);
  const summaryTokens = summary ? estimateTokens(summary.summary) : 0;
  const messageTokens = [...pinnedMessages, ...recentMessages]
    .filter((message, index, all) => all.findIndex((item) => item.id === message.id) === index)
    .reduce((total, message) => total + estimateTokens(renderSearchableText(message.parts)), 0);

  return {
    estimatedTokens: summaryTokens + messageTokens,
    summaryIncluded: Boolean(summary),
    summaryTokens,
    pinnedMessageCount: pinnedMessages.length,
    recentMessageCount: recentMessages.length,
    omittedMessageCount: messages.filter((message) => !includedIds.has(message.id)).length,
    totalCompleteMessages: messages.length
  };
}

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

function serializeMessage(
  msg: Message,
  currentAgentId: string,
  isGroup: boolean,
  artifactTitles: Map<string, string>
): ChatMessage[] {
  if (msg.role === "system") return [];

  if (msg.role === "user") {
    const text = renderUserText(msg.parts);
    if (!text) return [];
    return [{ role: "user", content: text }];
  }

  // Agent message
  const isSelf = msg.agentId === currentAgentId;
  const text = renderAgentPublicText(msg.parts, artifactTitles);
  if (!text) return [];

  if (isSelf) {
    return [{ role: "assistant", content: text }];
  }

  // Other agent in group chat
  if (isGroup) {
    const agentName = msg.agentId ?? "Agent";
    return [{ role: "user", content: `[${agentName}] ${text}` }];
  }

  return [];
}

function renderUserText(parts: MessagePart[]): string {
  const chunks: string[] = [];
  for (const p of parts) {
    if (p.type === "text") {
      chunks.push(p.content);
    } else if (p.type === "image_attachment") {
      chunks.push(`[图片附件: ${p.fileName}]`);
    } else if (p.type === "file_attachment") {
      chunks.push(`[文件附件: ${p.fileName}]`);
    }
  }
  return chunks.join("\n").trim();
}

function renderAgentPublicText(
  parts: MessagePart[],
  artifactTitles: Map<string, string>
): string {
  const chunks: string[] = [];
  for (const p of parts) {
    if (p.type === "text") {
      chunks.push(p.content);
    } else if (p.type === "code") {
      chunks.push(p.content);
    } else if (p.type === "artifact_ref") {
      const title = artifactTitles.get(p.artifactId) ?? `art_unknown`;
      chunks.push(`[产物: ${title} (id=${p.artifactId})]`);
    } else if (p.type === "deploy_status") {
      const dep = p.deployment;
      if (dep.status === "failed") {
        chunks.push(`[部署失败: ${dep.error ?? "unknown error"}]`);
      } else {
        chunks.push(`[部署预览: ${dep.title} (${dep.previewPath})]`);
      }
    }
    // Drop: thinking, tool_use, tool_result
  }
  return chunks.join("\n").trim();
}

/** @deprecated Use getLatestSummary from context-compaction-service instead */
function getLatestContextSummary(conversationId: string) {
  return getLatestSummary(conversationId);
}

// ---------------------------------------------------------------------------
// Context compaction — LLM-powered summarization
// ---------------------------------------------------------------------------

/**
 * Build the system + user prompts for the compaction LLM call.
 * The compaction model receives the raw conversation text and produces a
 * structured summary that preserves task context, decisions, and artifacts.
 */
export function buildCompactionPrompt(
  messages: Array<{ role: string; agentName?: string; content: string }>,
  existingSummary?: string | null
): { systemPrompt: string; userPrompt: string } {
  const systemPrompt = `You are a conversation archivist for a multi-agent collaboration platform.
Your task is to compress a conversation into a concise, structured summary.

The summary must be DENSE — every sentence should carry information. Cut greetings,
repetitions, and filler. Preserve ALL of the following:

1. **User Requests**: every explicit request the user made, with any clarifications or
   choices they gave (especially ask_user Q&A results).
2. **Task Assignments**: which agent was asked to do what, with task IDs if present.
3. **Decisions & Outcomes**: what was decided, what succeeded, what failed and why.
4. **Artifacts**: every artifact reference (art_xxx) with its type and title.
5. **Files**: paths created or modified, with a one-word purpose each.
6. **Pending Items**: anything not yet done, blocked, or waiting for user input.

Output format — use this exact Markdown structure:

## 用户请求
- (one bullet per distinct user request)

## 任务与结果
- (one bullet per task: Agent → what → outcome)

## 产物
- (one bullet per artifact: type title (id=art_xxx))

## 文件
- (one bullet per file path: purpose)

## 待办
- (items not yet resolved)

Keep the total output under 1500 characters. Prefer bullets over prose.
Use Chinese for user-facing content, English for technical identifiers.`;

  // Build the conversation text
  const conversationText = messages
    .map((m) => {
      const label = m.agentName ? `[${m.agentName}] ` : m.role === "user" ? "[用户] " : "";
      return `${label}${m.content}`;
    })
    .join("\n\n");

  const userPrompt = `${existingSummary ? `Previous summary for context:\n${existingSummary}\n\n` : ""}New messages to compress (${messages.length} messages):\n\n${conversationText}\n\nPlease compress the above conversation into the specified structured summary format.`;

  return { systemPrompt, userPrompt };
}

/**
 * Run LLM-powered compaction on a conversation.
 * Publishes progress events via EventBus → SSE → frontend.
 * Stores the result in conversation_context_summaries.
 */
export async function runCompaction(
  conversationId: string,
  messages: Array<{ role: string; agentName?: string; content: string }>,
  coveredUntilMessageId: string,
  coveredUntilCreatedAt: number,
  sourceMessageCount: number,
  modelProvider: string = "deepseek",
  modelId: string = "deepseek-chat",
  apiKeyOverride?: string | null,
  apiBaseUrl?: string | null,
  existingSummaryOverride?: string | null,
  skipDbStore: boolean = false,
  externalSignal?: AbortSignal,
  skipStartEvent: boolean = false
): Promise<{ summary: string; tokenEstimate: number; summaryId: string | null }> {
  const existingSummary = existingSummaryOverride !== null && existingSummaryOverride !== undefined
    ? { summary: existingSummaryOverride }
    : getLatestContextSummary(conversationId);

  // Publish start event (skip for intermediate rolling chunks)
  if (!skipStartEvent) {
    eventBus.publish({
      type: "compaction.start",
      conversationId,
      timestamp: Date.now(),
      sourceMessageCount
    });
  }

  // Build prompts
  eventBus.publish({
    type: "compaction.progress",
    conversationId,
    timestamp: Date.now(),
    stage: "reading",
    detail: `正在分析 ${sourceMessageCount} 条消息...`
  });

  const { systemPrompt, userPrompt } = buildCompactionPrompt(messages, existingSummary?.summary);

  // Resolve API key
  const settings = getSettings();
  const apiKey = resolveApiKey(modelProvider, apiKeyOverride ?? null, settings);
  if (!apiKey) {
    const error = `缺少 ${modelProvider} API Key，无法压缩上下文。请在设置或会话 Agent 中配置 Key。`;
    publishCompactionError(conversationId, error);
    throw new Error(error);
  }

  // Call LLM for smart compaction
  eventBus.publish({
    type: "compaction.progress",
    conversationId,
    timestamp: Date.now(),
    stage: "summarizing",
    detail: "正在调用 AI 生成摘要..."
  });

  try {
    const response = await fetch(`${resolveBaseUrl(modelProvider, apiBaseUrl)}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: modelId,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt }
        ],
        max_tokens: 1024,
        temperature: 0.3
      }),
      signal: externalSignal ?? AbortSignal.timeout(30000)
    });

    if (!response.ok) {
      const responseText = await response.text().catch(() => "");
      throw new Error(`上下文压缩模型请求失败（HTTP ${response.status}）${responseText ? `：${responseText.slice(0, 160)}` : ""}`);
    }

    const data = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
    const summary = data.choices?.[0]?.message?.content?.trim();
    if (!summary) {
      throw new Error("上下文压缩模型没有返回摘要内容。");
    }

    // P2: Intermediate chunks don't store to DB — only the last chunk does
    if (skipDbStore) {
      const tokenEstimate = Math.ceil(summary.length / 4);
      eventBus.publish({ type: "compaction.progress", conversationId, timestamp: Date.now(), stage: "storing", detail: "中间 chunk 摘要已生成..." });
      return { summary, tokenEstimate, summaryId: null };
    }

    return storeCompactionResult(conversationId, summary, coveredUntilMessageId, coveredUntilCreatedAt, sourceMessageCount, modelProvider, modelId);
  } catch (error) {
    const message = error instanceof Error ? error.message : "上下文压缩失败。";
    publishCompactionError(conversationId, message);
    throw error instanceof Error ? error : new Error(message);
  }
}

// ---------------------------------------------------------------------------
// Internal helpers for compaction
// ---------------------------------------------------------------------------

async function storeCompactionResult(
  conversationId: string,
  summary: string,
  coveredUntilMessageId: string,
  coveredUntilCreatedAt: number,
  sourceMessageCount: number,
  modelProvider: string | null,
  modelId: string | null
): Promise<{ summary: string; tokenEstimate: number; summaryId: string }> {
  const now = Date.now();
  const tokenEstimate = Math.ceil(summary.length / 4);
  const summaryId = newContextSummaryId();

  // P0: Validate boundary before saving
  const boundaryError = validateSummaryBoundary(conversationId, coveredUntilMessageId);
  if (boundaryError) {
    publishCompactionError(conversationId, boundaryError);
    throw new Error(boundaryError);
  }

  eventBus.publish({
    type: "compaction.progress",
    conversationId,
    timestamp: now,
    stage: "storing",
    detail: "正在保存压缩结果..."
  });

  const db = getDatabase();
  db.prepare(`
    INSERT INTO conversation_context_summaries (
      id, conversation_id, summary, covered_until_message_id,
      covered_until_created_at, source_message_count, token_estimate,
      model_provider, model_id, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    summaryId, conversationId, summary,
    coveredUntilMessageId, coveredUntilCreatedAt,
    sourceMessageCount, tokenEstimate,
    modelProvider, modelId, now
  );

  eventBus.publish({
    type: "compaction.end",
    conversationId,
    timestamp: now,
    sourceMessageCount,
    coveredUntilMessageId,
    summary,
    tokenEstimate
  });

  return { summary, tokenEstimate, summaryId };
}

function publishCompactionError(conversationId: string, error: string) {
  eventBus.publish({
    type: "compaction.error",
    conversationId,
    timestamp: Date.now(),
    error
  });
}

function resolveBaseUrl(provider: string, override?: string | null): string {
  if (override?.trim()) {
    return override.trim().replace(/\/+$/, "").replace(/\/v1$/, "") + "/v1";
  }
  switch (provider) {
    case "deepseek":
      return (process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com").replace(/\/+$/, "") + "/v1";
    case "openai":
      return (process.env.OPENAI_BASE_URL ?? "https://api.openai.com").replace(/\/+$/, "") + "/v1";
    case "anthropic":
      return (process.env.ANTHROPIC_BASE_URL ?? "https://api.anthropic.com").replace(/\/+$/, "") + "/v1";
    default:
      return "https://api.deepseek.com/v1";
  }
}

function renderSearchableText(parts: MessagePart[]): string {
  return parts
    .filter((part) => part.type === "text" || part.type === "code")
    .map((part) => part.content)
    .join("\n");
}
