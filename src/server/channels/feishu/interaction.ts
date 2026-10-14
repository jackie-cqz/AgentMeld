import type { CardActionEvent } from "@larksuite/channel";
import { eventBus } from "@/server/event-bus";
import { answerQuestion, getPendingQuestion } from "@/server/pending-questions";
import { getChannelConversationByConversationId } from "@/server/repositories";
import { getFeishuChannelForAgent } from "@/server/channels/feishu/connection";
import type { PendingQuestion } from "@/shared/types";

/**
 * Ask the user a question in the room, and take the answer from the button.
 *
 * §5.4's rule applies here and is why this is shaped the way it is: a card
 * callback must never be awaited from the message handler (the SDK serialises
 * per chat and the click would sit behind the work it is meant to unblock).
 * Nothing here awaits a run — it posts a card, and the callback resolves a
 * pending record the run is already waiting on.
 *
 * Partial answers are held in memory rather than resolved as they arrive.
 * `answerQuestion` resolves with whatever it is given and deletes the record,
 * so sending it a single answer out of three would silently discard the other
 * two. If the process restarts mid-question the collected answers are lost and
 * the user clicks again; the card is the record of what was clicked.
 */

/** What a button carries. Decoded defensively — a card value is untrusted input. */
export type CardActionValue = {
  kind: "ask_user";
  pendingId: string;
  questionIndex: number;
  answer: string;
};

export function decodeCardActionValue(value: unknown): CardActionValue | null {
  if (typeof value !== "object" || value === null) return null;
  const raw = value as Record<string, unknown>;
  if (raw.kind !== "ask_user") return null;
  if (typeof raw.pendingId !== "string" || !raw.pendingId) return null;
  if (typeof raw.questionIndex !== "number" || !Number.isInteger(raw.questionIndex)) return null;
  if (typeof raw.answer !== "string") return null;
  return {
    kind: "ask_user",
    pendingId: raw.pendingId,
    questionIndex: raw.questionIndex,
    answer: raw.answer
  };
}

/**
 * The card for a question.
 *
 * Exported as a pure function because the card is the thing a person sees, and
 * its shape is worth pinning without a platform round trip.
 */
export function buildQuestionCard(
  question: PendingQuestion,
  state: { answered?: Record<string, string>; answeredBy?: string } = {}
): object {
  const answered = state.answered ?? {};
  const elements: object[] = [];

  question.questions.forEach((item, index) => {
    const chosen = answered[item.question];
    elements.push({
      tag: "div",
      text: {
        tag: "lark_md",
        content: `**${item.header}**\n${item.question}${chosen ? `\n\n已选择：**${chosen}**` : ""}`
      }
    });
    // Answered questions keep their buttons visible but inert: the card stays a
    // readable record of what was asked, rather than turning into a bare label.
    elements.push({
      tag: "action",
      actions: item.options.map((option) => ({
        tag: "button",
        text: { tag: "plain_text", content: option.label },
        type: chosen === option.label ? "primary" : "default",
        ...(chosen
          ? {}
          : {
              value: {
                kind: "ask_user",
                pendingId: question.id,
                questionIndex: index,
                answer: option.label
              } satisfies CardActionValue
            })
      }))
    });
  });

  return {
    config: { wide_screen_mode: true },
    header: {
      template: "blue",
      title: { tag: "plain_text", content: "需要你的回答" }
    },
    elements
  };
}

declare global {
  var __agentMeldChannelAnswers: Map<string, Record<string, string>> | undefined;
  var __agentMeldChannelInteractionStop: (() => void) | undefined;
}

function getAnswerBuffer(): Map<string, Record<string, string>> {
  globalThis.__agentMeldChannelAnswers ??= new Map<string, Record<string, string>>();
  return globalThis.__agentMeldChannelAnswers;
}

/**
 * Take a button click. Returns the card to show in its place, or a toast when
 * the click did not complete the question.
 *
 * The operator's name is recorded as the resolver, because "who approved this"
 * is the question the record exists to answer — and it comes from the platform's
 * callback identity, not from anything the caller can type.
 */
export async function handleCardAction(
  event: CardActionEvent
): Promise<Record<string, unknown> | undefined> {
  const value = decodeCardActionValue(event.action?.value);
  if (!value) return undefined;

  const entry = getPendingQuestion(value.pendingId);
  if (!entry) {
    return { toast: { type: "info", content: "这个问题已经处理过了。" } };
  }

  const question = entry.question;
  const asked = question.questions[value.questionIndex];
  if (!asked) return { toast: { type: "error", content: "这张卡片已经过期。" } };

  const buffer = getAnswerBuffer();
  const answers = { ...(buffer.get(question.id) ?? {}), [asked.question]: value.answer };
  buffer.set(question.id, answers);

  if (Object.keys(answers).length < question.questions.length) {
    return {
      card: { type: "raw", data: buildQuestionCard(question, { answered: answers }) }
    };
  }

  buffer.delete(question.id);
  const resolved = answerQuestion(question.id, answers, event.operator?.name ?? event.operator?.openId ?? null);
  if (!resolved) {
    return { toast: { type: "info", content: "这个问题已经处理过了。" } };
  }

  return {
    card: {
      type: "raw",
      data: buildQuestionCard(question, {
        answered: answers,
        answeredBy: event.operator?.name
      })
    },
    toast: { type: "success", content: "已回答。" }
  };
}

export type InteractionOutcome =
  | { status: "posted"; chatId: string }
  | { status: "skipped"; reason: string };

/**
 * Put a new question in the room, as the agent that asked it.
 *
 * No fallback to another agent's bot, for the same reason the rest of the
 * projection has none: being asked by the wrong agent is worse than not being
 * asked here at all.
 */
export async function projectPendingQuestion(
  question: PendingQuestion
): Promise<InteractionOutcome> {
  const channelConversation = getChannelConversationByConversationId(question.conversationId);
  if (!channelConversation) return { status: "skipped", reason: "conversation is not on a channel" };

  const channel = getFeishuChannelForAgent(question.agentId);
  if (!channel) return { status: "skipped", reason: "agent has no live channel" };

  const sent = await channel.send(channelConversation.chatId, {
    card: buildQuestionCard(question)
  });
  console.info(`[feishu] asked a question in ${channelConversation.chatId} (${sent.messageId})`);
  return { status: "posted", chatId: channelConversation.chatId };
}

/**
 * Post a question whenever one is asked.
 *
 * Subscribes once per process, like the other channel subscriptions: a second
 * would ask the same question twice in the room.
 */
export function startChannelInteractions(): () => void {
  if (globalThis.__agentMeldChannelInteractionStop) return globalThis.__agentMeldChannelInteractionStop;

  const stop = eventBus.subscribe((entry) => {
    if (entry.event.type !== "ask_user.pending") return;
    void projectPendingQuestion(entry.event.pendingQuestion).catch((error: unknown) => {
      console.error("[feishu] failed to post a question:", error);
    });
  });

  globalThis.__agentMeldChannelInteractionStop = stop;
  return stop;
}

export function stopChannelInteractionsForTests(): void {
  globalThis.__agentMeldChannelInteractionStop?.();
  globalThis.__agentMeldChannelInteractionStop = undefined;
  globalThis.__agentMeldChannelAnswers = undefined;
}
