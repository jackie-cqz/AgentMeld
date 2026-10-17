import { getConversation, getAgent, listMessages } from "@/server/repositories";
import { startConversationCompaction } from "@/server/context-compaction-runner";
import { calculateContextBudget, getLatestSummary } from "@/server/context-compaction-service";
import {
  buildHistoryWithStats,
  type ChatMessage
} from "@/server/conversation-context";
import { estimateTokens } from "@/shared/token-estimate";
import {
  autoCompactionThreshold,
  getModelLimits,
  resolveContextWindow
} from "@/shared/model-registry";
import type { Agent, Message } from "@/shared/types";

export interface RunContextInput {
  agent: Agent;
  conversationId: string;
  /** Never consume the message that triggered this run. */
  excludeMessageId?: string;
  /** Never consume messages posted after the trigger. */
  beforeMessageId?: string;
  systemTokens: number;
  currentTurnTokens: number;
}

export interface RunContextResult {
  messages: ChatMessage[];
  /** Complete messages omitted by truncation in this run (0 = nothing lost). */
  droppedMessageCount: number;
  /** Whether the 80% threshold fired an app-level compaction job. */
  compactionTriggered: boolean;
  /** Why auto-compaction did not start, when it was attempted but refused. */
  compactionReason: string | null;
  /** The window this run was measured against (configured, or the default). */
  contextWindow: number;
  estimatedTokens: number;
}

/**
 * Build the cross-run prompt for one Agent run and enforce the configured window.
 *
 * Both context modes take this same path: at 80% of the window the app-level
 * compactor is started (it shortens history for the *next* run), and this run
 * is then bounded by the remaining budget. If that still does not fit, the
 * oldest non-pinned messages are dropped and the count is returned so the
 * caller can tell the user instead of losing history silently.
 */
export async function buildRunHistory(input: RunContextInput): Promise<RunContextResult> {
  const conversation = getConversation(input.conversationId);
  if (!conversation) {
    return {
      messages: [],
      droppedMessageCount: 0,
      compactionTriggered: false,
      compactionReason: null,
      contextWindow: resolveContextWindow(input.agent),
      estimatedTokens: 0
    };
  }

  const contextWindow = resolveContextWindow(input.agent);
  const limits = getModelLimits(input.agent.modelProvider);
  const threshold = autoCompactionThreshold(contextWindow);
  const options = {
    excludeMessageId: input.excludeMessageId,
    beforeMessageId: input.beforeMessageId,
    contextMode: conversation.contextMode
  } as const;

  // Unbounded selection tells us what this run *would* inject. That is the
  // number the 80% trigger is measured against.
  const unbounded = await buildHistoryWithStats(input.agent.id, input.conversationId, options);
  const unboundedTokens = unbounded.messages.reduce((sum, message) => sum + estimateTokens(message.content), 0);

  let compactionTriggered = false;
  let compactionReason: string | null = null;
  if (input.systemTokens + unboundedTokens + input.currentTurnTokens >= threshold) {
    const result = startConversationCompaction(input.conversationId);
    compactionTriggered = result.ok;
    compactionReason = result.ok ? null : result.reason;
  }

  const summary = getLatestSummary(input.conversationId);
  const summaryTokens = summary ? estimateTokens(summary.summary) : 0;
  const messages = listMessages(input.conversationId);
  const pinnedIds = new Set(conversation.pinnedMessageIds);
  const pinnedTokens = messages
    .filter((message) => message.status === "complete" && pinnedIds.has(message.id))
    .reduce((sum, message) => sum + estimateTokens(extractTextFromMessage(message)), 0);

  const budget = calculateContextBudget(
    contextWindow,
    limits.outputReserve,
    input.systemTokens,
    summaryTokens + unbounded.factsTokens,
    pinnedTokens,
    input.currentTurnTokens
  );

  // Pinned messages are counted by the builder but immune to truncation, so
  // add them back: the non-pinned history may use the full remaining budget.
  const tokenBudget = Math.max(0, budget.remainingTokens) + (pinnedTokens > 0 ? pinnedTokens : 0);
  const bounded = await buildHistoryWithStats(input.agent.id, input.conversationId, {
    ...options,
    tokenBudget
  });
  const estimatedTokens = bounded.messages.reduce((sum, message) => sum + estimateTokens(message.content), 0);

  return {
    messages: bounded.messages,
    droppedMessageCount: bounded.droppedMessageCount,
    compactionTriggered,
    compactionReason,
    contextWindow,
    estimatedTokens
  };
}

function extractTextFromMessage(message: Message): string {
  return message.parts.filter((part) => part.type === "text" || part.type === "code")
    .map((part) => part.content).join("\n");
}

/** Convenience for the run path: the pinned cost used for the overflow guard. */
export function pinnedContextTokens(conversationId: string): { tokens: number; count: number } {
  const conversation = getConversation(conversationId);
  if (!conversation) return { tokens: 0, count: 0 };
  const pinnedIds = new Set(conversation.pinnedMessageIds);
  const pinned = listMessages(conversationId).filter((message) => message.status === "complete" && pinnedIds.has(message.id));
  return {
    tokens: pinned.reduce((sum, message) => sum + estimateTokens(extractTextFromMessage(message)), 0),
    count: conversation.pinnedMessageIds.length
  };
}

/** The Agent a conversation budget is measured against (its first member). */
export function conversationBudgetAgent(conversationId: string): Agent | null {
  const conversation = getConversation(conversationId);
  if (!conversation || conversation.agentIds.length === 0) return null;
  return getAgent(conversation.agentIds[0]);
}
