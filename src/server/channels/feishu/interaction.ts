import type { CardActionEvent } from "@larksuite/channel";
import { eventBus } from "@/server/event-bus";
import { isChannelProjectionPaused } from "@/server/channels/feishu/projection";
import { cancelRunFromCard } from "@/server/channels/feishu/progress";
import { answerQuestion, getPendingQuestion } from "@/server/pending-questions";
import { approvePlan, getPendingPlan, rejectPlan } from "@/server/dispatch-plan-manager";
import { approvePendingBash, getPendingBash, rejectPendingBash } from "@/server/pending-bash";
import { approvePendingWrite, getPendingWrite, rejectPendingWrite } from "@/server/pending-writes";
import {
  getChannelBindingForAgent,
  getChannelConversationByConversationId,
  getRun
} from "@/server/repositories";
import { getFeishuChannelForAgent } from "@/server/channels/feishu/registry";
import { deliverSend, deliverCardUpdate } from "@/server/channels/feishu/delivery";
import type {
  DispatchPlanItem,
  PendingBashCommand,
  PendingDispatchPlan,
  PendingQuestion,
  PendingWrite
} from "@/shared/types";

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
 * two.
 *
 * Restarting mid-question loses more than the collected answers: the pending
 * question itself lives only in memory, and recovery marks the run failed. A
 * click on the old card then lands on "already handled", and the only way
 * forward is to start the task again. An earlier version of this comment said
 * the user would simply click again, which is not possible.
 */

/** The three things that wait for a decision. */
export type ApprovalKind = "plan" | "bash" | "write";

/**
 * What a button carries. Decoded defensively — a card value is untrusted input,
 * and it comes back from the platform rather than from anything we hold.
 */
export type CardActionValue =
  | { kind: "ask_user"; pendingId: string; questionIndex: number; answer: string }
  | {
      kind: "approval";
      pendingType: ApprovalKind;
      pendingId: string;
      decision: "approve" | "reject";
    }
  | { kind: "cancel_run"; runId: string };

const APPROVAL_KINDS: ApprovalKind[] = ["plan", "bash", "write"];

export function decodeCardActionValue(value: unknown): CardActionValue | null {
  if (typeof value !== "object" || value === null) return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.pendingId !== "string" || !raw.pendingId) return null;

  if (raw.kind === "ask_user") {
    if (typeof raw.questionIndex !== "number" || !Number.isInteger(raw.questionIndex)) return null;
    if (typeof raw.answer !== "string") return null;
    return {
      kind: "ask_user",
      pendingId: raw.pendingId,
      questionIndex: raw.questionIndex,
      answer: raw.answer
    };
  }

  if (raw.kind === "cancel_run") {
    if (typeof raw.runId !== "string" || !raw.runId) return null;
    return { kind: "cancel_run", runId: raw.runId };
  }

  if (raw.kind === "approval") {
    if (!APPROVAL_KINDS.includes(raw.pendingType as ApprovalKind)) return null;
    if (raw.decision !== "approve" && raw.decision !== "reject") return null;
    return {
      kind: "approval",
      pendingType: raw.pendingType as ApprovalKind,
      pendingId: raw.pendingId,
      decision: raw.decision
    };
  }

  return null;
}

/** One row per task, so a person can see what they are approving. */
function describePlan(plan: DispatchPlanItem[]): string {
  return plan
    .map(
      (item, index) =>
        `${index + 1}. **${escapeLarkMd(item.title ?? item.task)}** — ${escapeLarkMd(item.agentId)}`
    )
    .join("\n");
}

/**
 * The card for something waiting on a decision.
 *
 * Exported as a pure function for the same reason the question card is: it is
 * what a person sees, and its shape is worth pinning without a platform round
 * trip. Bash shows the command and write shows the path and size rather than the
 * whole file — a diff in a chat is unreadable, and the full content is on the
 * web where it belongs.
 */
export function buildApprovalCard(
  kind: ApprovalKind,
  item: PendingDispatchPlan | PendingBashCommand | PendingWrite,
  state: { decision?: "approve" | "reject"; decidedBy?: string } = {}
): object {
  const title =
    kind === "plan" ? "计划待批准" : kind === "bash" ? "命令待批准" : "文件写入待批准";
  const body =
    kind === "plan"
      ? describePlan((item as PendingDispatchPlan).plan)
      : kind === "bash"
        ? `\`\`\`\n${sanitizeCommand((item as PendingBashCommand).command)}\n\`\`\`\n\n目录：${escapeLarkMd((item as PendingBashCommand).cwd)}\n\n原因：${escapeLarkMd((item as PendingBashCommand).reason)}`
        : `路径：\`${escapeLarkMd((item as PendingWrite).path)}\``;

  const decided = state.decision;
  const buttons: object[] = decided
    ? []
    : (["approve", "reject"] as const).map((decision) => ({
        tag: "button",
        text: { tag: "plain_text", content: decision === "approve" ? "批准" : "拒绝" },
        type: decision === "approve" ? "primary" : "danger",
        value: {
          kind: "approval",
          pendingType: kind,
          pendingId: item.id,
          decision
        } satisfies CardActionValue
      }));

  return {
    config: { wide_screen_mode: true },
    header: {
      template: decided === "reject" ? "red" : decided === "approve" ? "green" : "orange",
      title: { tag: "plain_text", content: title }
    },
    elements: [
      { tag: "div", text: { tag: "lark_md", content: body } },
      ...(decided
        ? [
            {
              tag: "div",
              text: {
                tag: "lark_md",
                content: `已${decided === "approve" ? "批准" : "拒绝"}${state.decidedBy ? `：${escapeLarkMd(state.decidedBy)}` : ""}`
              }
            }
          ]
        : []),
      ...(buttons.length
        ? [{ tag: "action", actions: buttons }]
        : [])
    ]
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
  state: {
    /** Answers by question TEXT — what a resolved record carries. */
    answered?: Record<string, string>;
    /**
     * Answers by question INDEX — what is collected while the card is only
     * partly answered. Two questions can share their text, so the index is the
     * only key that tells them apart.
     */
    answeredByIndex?: Record<string, string>;
    answeredBy?: string;
    cancelled?: boolean;
  } = {}
): object {
  const answered = state.answered ?? {};
  const answeredByIndex = state.answeredByIndex ?? {};
  const elements: object[] = [];

  question.questions.forEach((item, index) => {
    // Per question, not per card. This used to be one flag for the whole card —
    // "terminal" the moment ANY question had an answer — so answering the first
    // of two questions stripped the buttons from the second as well, and the
    // rest of the card could not be answered from the room. It also looked the
    // answer up by question text in a buffer keyed by index, so it never found
    // it: the card that came back showed no selection at all.
    const chosen = answeredByIndex[String(index)] ?? answered[item.question];
    // Nobody may click an answered question again, or any question on a card
    // that has been cancelled — which has no answers, and was the reason the
    // flag existed.
    const inert = state.cancelled === true || chosen !== undefined;
    elements.push({
      tag: "div",
      text: {
        tag: "lark_md",
        content:
          `**${escapeLarkMd(item.header)}**\n${escapeLarkMd(item.question)}` +
          (chosen ? `\n\n已选择：**${escapeLarkMd(chosen)}**` : "")
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
        ...(inert
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

  if (state.cancelled) {
    elements.push({ tag: "div", text: { tag: "lark_md", content: "这个问题已经作废。" } });
  }

  if (state.answeredBy && (Object.keys(answered).length > 0 || Object.keys(answeredByIndex).length > 0)) {
    elements.push({
      tag: "div",
      text: { tag: "lark_md", content: `已由 **${escapeLarkMd(state.answeredBy)}** 回答` }
    });
  }

  return {
    config: { wide_screen_mode: true },
    header: {
      template: "blue",
      title: { tag: "plain_text", content: "需要你的回答" }
    },
    elements
  };
}

/**
 * Neutralise card markup in text this bot did not author.
 *
 * Question text and headers come from a model, and `lark_md` renders tags — an
 * `<at id=all></at>` in a question would summon the whole room in this bot's
 * name. Stripping the angle brackets leaves the text readable and inert; this is
 * the same treatment the SDK applies to names it puts into mentions.
 */
function escapeLarkMd(text: string): string {
  return text.replace(/[<>]/g, "");
}

/**
 * Neutralise a command without misrepresenting it.
 *
 * A command being approved has to be shown as it is — approving `echo a` when
 * the real command is `echo a > b` is worse than any markup risk. So only `<`
 * goes: it is what opens a tag, while `>`, `>>` and `|` stay readable. A tag
 * cannot form from half of itself.
 */
function sanitizeCommand(command: string): string {
  return command.replace(/</g, "").replace(/```/g, "");
}

/**
 * Whether this person may answer for this agent.
 *
 * The single-owner model the rest of the app uses: the account that scanned the
 * app is the one that speaks for it. Without a check here, anyone who can see
 * the card can answer a question the run is waiting on — and a group is exactly
 * where people who are not the owner are present.
 *
 * A binding with no recorded owner denies everyone rather than allowing
 * everyone. That state should not exist, and failing closed is the only safe
 * reading of "we do not know who owns this".
 */
export function isAuthorisedOperator(agentId: string, openId: string | undefined): boolean {
  if (!openId) return false;
  const binding = getChannelBindingForAgent(agentId, "feishu");
  if (!binding?.boundByOpenId) return false;
  return binding.boundByOpenId === openId;
}

/** A card this bot put in a room, kept so it can be updated when it is settled. */
interface PostedCard {
  chatId: string;
  messageId: string;
  agentId: string;
  question: PendingQuestion;
}

/** An approval card this bot put in a room, kept so it can be settled later. */
interface PostedApproval {
  chatId: string;
  messageId: string;
  agentId: string;
  kind: ApprovalKind;
  item: PendingDispatchPlan | PendingBashCommand | PendingWrite;
}

declare global {
  var __agentMeldChannelAnswers: Map<string, Record<string, string>> | undefined;
  var __agentMeldChannelCards: Map<string, PostedCard> | undefined;
  var __agentMeldChannelApprovalCards: Map<string, PostedApproval> | undefined;
  var __agentMeldChannelInteractionStop: (() => void) | undefined;
}

function getPostedCards(): Map<string, PostedCard> {
  globalThis.__agentMeldChannelCards ??= new Map<string, PostedCard>();
  return globalThis.__agentMeldChannelCards;
}

function getPostedApprovals(): Map<string, PostedApproval> {
  globalThis.__agentMeldChannelApprovalCards ??= new Map<string, PostedApproval>();
  return globalThis.__agentMeldChannelApprovalCards;
}

function getAnswerBuffer(): Map<string, Record<string, string>> {
  globalThis.__agentMeldChannelAnswers ??= new Map<string, Record<string, string>>();
  return globalThis.__agentMeldChannelAnswers;
}

/**
 * Take a button click. Returns the card to show in its place, or a toast when
 * the click did not complete the question.
 *
 * The operator is resolved from the platform's callback identity AND checked
 * against the account that bound the app, because "who answered" is the question
 * the record exists to answer. The display name is also recorded, but only ever
 * alongside — a display name is set by its owner and cannot be an identity.
 */
export async function handleCardAction(
  event: CardActionEvent
): Promise<Record<string, unknown> | undefined> {
  const value = decodeCardActionValue(event.action?.value);
  if (!value) return undefined;

  if (value.kind === "ask_user") return handleQuestionAnswer(value, event);
  if (value.kind === "approval") return handleApprovalDecision(value, event);
  return handleCancelRun(value, event);
}

async function handleQuestionAnswer(
  value: Extract<CardActionValue, { kind: "ask_user" }>,
  event: CardActionEvent
): Promise<Record<string, unknown> | undefined> {
  const entry = getPendingQuestion(value.pendingId);
  if (!entry) {
    return { toast: { type: "info", content: "这个问题已经处理过了。" } };
  }

  if (!isAuthorisedOperator(entry.question.agentId, event.operator?.openId)) {
    return { toast: { type: "error", content: "只有绑定这个应用的账号可以回答。" } };
  }

  // The click must come from the chat this question belongs to. A card can be
  // forwarded, and without this its buttons would answer a question in a room
  // the clicker is not in.
  // Fail closed: an unmapped conversation used to skip this check entirely, so
  // a deleted mapping turned the guard off.
  const where = getChannelConversationByConversationId(entry.question.conversationId);
  if (!where || where.chatId !== event.chatId) {
    return { toast: { type: "error", content: "这张卡片不属于这个群。" } };
  }

  const question = entry.question;
  const asked = question.questions[value.questionIndex];
  if (!asked) return { toast: { type: "error", content: "这张卡片已经过期。" } };

  // The answer must be one the card offered. Without this any string is
  // accepted, so a forwarded or hand-crafted card value can put arbitrary text
  // into the run as though the user had chosen it.
  if (!asked.options.some((option) => option.label === value.answer)) {
    return { toast: { type: "error", content: "这个选项已经失效，请重新点击卡片。" } };
  }

  const buffer = getAnswerBuffer();
  // Keyed by the question's INDEX, not its text: two questions with identical
  // text collapse into one key and the count can never reach the number of
  // questions, so the run waits forever for an answer it already has.
  //
  // On races, which F2 asks to handle: a second PERSON cannot overwrite a first
  // person's answer, because only the account that bound the app may answer at
  // all — `isAuthorisedOperator` above refuses everyone else, and a test pins
  // that. So the only reachable repeat is the owner clicking again, from the
  // same device or another, and for one person the last answer is the one they
  // meant. Writing a first-wins rule for the other case would be a branch
  // nothing can reach; if the owner check is ever loosened, this is the
  // invariant that has to be decided then.
  const answers = { ...(buffer.get(question.id) ?? {}), [String(value.questionIndex)]: value.answer };
  buffer.set(question.id, answers);

  if (Object.keys(answers).length < question.questions.length) {
    return {
      card: { type: "raw", data: buildQuestionCard(question, { answeredByIndex: answers }) }
    };
  }

  buffer.delete(question.id);
  // `answerQuestion` keys its record by the question's TEXT, so the buffered
  // indices are translated back here.
  const byText = Object.fromEntries(
    Object.entries(answers).map(([index, answer]) => [
      question.questions[Number(index)]?.question ?? index,
      answer
    ])
  );
  // The operator id, not their display name. A display name is chosen by its
  // owner, and this codebase says so in two other places; recording one as the
  // resolver would make the audit answer forgeable.
  const resolved = answerQuestion(question.id, byText, event.operator?.openId ?? null);
  if (!resolved) {
    return { toast: { type: "info", content: "这个问题已经处理过了。" } };
  }

  return {
    card: {
      type: "raw",
      data: buildQuestionCard(question, { answeredByIndex: answers, answeredBy: event.operator?.name })
    },
    toast: { type: "success", content: "已回答。" }
  };
}

/**
 * Announce a decision the way the resolve routes do.
 *
 * Deliberately the same three events: a decision is a decision wherever it was
 * taken, and anything watching for one must not have to know which door it came
 * through.
 */
function publishApprovalResolved(
  kind: ApprovalKind,
  item: PendingDispatchPlan | PendingBashCommand | PendingWrite,
  approved: boolean
): void {
  const base = { conversationId: item.conversationId, timestamp: Date.now(), pendingId: item.id };
  if (kind === "plan") {
    eventBus.publish({
      type: "dispatch.plan.resolved",
      ...base,
      runId: (item as PendingDispatchPlan).runId,
      approved
    });
    return;
  }
  if (kind === "bash") {
    eventBus.publish({ type: "bash_command.resolved", ...base, approved });
    return;
  }
  eventBus.publish({ type: "fs_write.resolved", ...base, applied: approved });
}

async function handleCancelRun(
  value: Extract<CardActionValue, { kind: "cancel_run" }>,
  event: CardActionEvent
): Promise<Record<string, unknown> | undefined> {
  const run = getRun(value.runId);
  if (!run) return { toast: { type: "info", content: "这次运行已经结束了。" } };

  const outcome = cancelRunFromCard(value.runId, event.operator?.openId, run.agentId);
  if (!outcome.ok) {
    // Not an error tone for a finished run — nothing went wrong, the moment
    // passed.
    return { toast: { type: outcome.message.includes("结束") ? "info" : "error", content: outcome.message } };
  }
  return { toast: { type: "success", content: "已取消。" } };
}

/** The pending item, or undefined when it is gone. */
function findApproval(kind: ApprovalKind, id: string) {
  // Each store wraps its item beside the resolver that will finish the run;
  // only the item is of any use here.
  if (kind === "plan") return getPendingPlan(id)?.plan;
  if (kind === "bash") return getPendingBash(id)?.command;
  return getPendingWrite(id)?.write;
}

/**
 * The agent a pending item belongs to, for the owner check.
 *
 * A plan has no agent of its own — it belongs to the conductor run that produced
 * it — so it is resolved through the run rather than assumed.
 */
function approvalAgentId(
  kind: ApprovalKind,
  item: PendingDispatchPlan | PendingBashCommand | PendingWrite
): string | null {
  if (kind === "plan") return getRun((item as PendingDispatchPlan).runId)?.agentId ?? null;
  return (item as PendingBashCommand | PendingWrite).agentId;
}

function decideApproval(
  kind: ApprovalKind,
  id: string,
  decision: "approve" | "reject",
  resolvedBy: string | null
): boolean {
  if (kind === "plan") return decision === "approve" ? approvePlan(id, undefined, resolvedBy) : rejectPlan(id, resolvedBy);
  if (kind === "bash") return decision === "approve" ? approvePendingBash(id, resolvedBy) : rejectPendingBash(id, resolvedBy);
  return decision === "approve" ? approvePendingWrite(id, resolvedBy) : rejectPendingWrite(id, resolvedBy);
}

async function handleApprovalDecision(
  value: Extract<CardActionValue, { kind: "approval" }>,
  event: CardActionEvent
): Promise<Record<string, unknown> | undefined> {
  const item = findApproval(value.pendingType, value.pendingId);
  if (!item) return { toast: { type: "info", content: "这条已经处理过了。" } };

  const agentId = approvalAgentId(value.pendingType, item);
  if (!agentId || !isAuthorisedOperator(agentId, event.operator?.openId)) {
    return { toast: { type: "error", content: "只有绑定这个应用的账号可以批准。" } };
  }

  // The same rule as the question card: the click must arrive where the item
  // belongs. This path had no such check at all.
  const where = getChannelConversationByConversationId(item.conversationId);
  if (!where || where.chatId !== event.chatId) {
    return { toast: { type: "error", content: "这张卡片不属于这个群。" } };
  }

  // The record's resolver is the operator id, not their display name: a display
  // name is chosen by its owner and cannot identify anyone.
  const resolvedBy = event.operator?.openId ?? null;
  const decided = decideApproval(value.pendingType, value.pendingId, value.decision, resolvedBy);
  if (!decided) return { toast: { type: "info", content: "这条已经处理过了。" } };

  // The web UI clears a pending when it sees the resolved event — the resolve
  // routes publish it, the underlying functions do not, and a decision taken in
  // the room used to leave the web showing a pending that was already settled.
  publishApprovalResolved(value.pendingType, item, value.decision === "approve");

  getPostedApprovals().delete(value.pendingId);

  return {
    card: {
      type: "raw",
      data: buildApprovalCard(value.pendingType, item, {
        decision: value.decision,
        decidedBy: event.operator?.name
      })
    },
    toast: { type: "success", content: value.decision === "approve" ? "已批准。" : "已拒绝。" }
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
  // The pause switch stops ALL outbound. The approval projector checked it and
  // this one did not, so a paused channel kept asking questions.
  if (isChannelProjectionPaused()) return { status: "skipped", reason: "paused" };

  const channelConversation = getChannelConversationByConversationId(question.conversationId);
  if (!channelConversation) return { status: "skipped", reason: "conversation is not on a channel" };

  const channel = getFeishuChannelForAgent(question.agentId);
  if (!channel) return { status: "skipped", reason: "agent has no live channel" };

  const sent = await deliverSend<{ messageId: string }>(
    channel,
    question.conversationId,
    question.agentId,
    channelConversation.chatId,
    { card: buildQuestionCard(question) }
  );
  // Kept so the card can be settled in place when the question is answered from
  // the web or abandoned. Without it the room keeps a card whose buttons only
  // say "already handled" once pressed.
  getPostedCards().set(question.id, {
    chatId: channelConversation.chatId,
    messageId: sent.messageId,
    agentId: question.agentId,
    question
  });
  console.info(`[feishu] asked a question in ${channelConversation.chatId} (${sent.messageId})`);
  return { status: "posted", chatId: channelConversation.chatId };
}

/**
 * Put something that needs a decision in the room.
 *
 * The pause switch applies, because it is an explicit instruction to stop all
 * outbound. The message rate limit does not: approvals are bounded by what the
 * run asks for, and a suppressed approval request is a run stuck with nobody
 * told why.
 */
export async function projectPendingApproval(
  kind: ApprovalKind,
  item: PendingDispatchPlan | PendingBashCommand | PendingWrite
): Promise<InteractionOutcome> {
  if (isChannelProjectionPaused()) return { status: "skipped", reason: "paused" };

  const channelConversation = getChannelConversationByConversationId(item.conversationId);
  if (!channelConversation) return { status: "skipped", reason: "conversation is not on a channel" };

  const agentId = approvalAgentId(kind, item);
  if (!agentId) return { status: "skipped", reason: "no agent owns this approval" };

  const channel = getFeishuChannelForAgent(agentId);
  if (!channel) return { status: "skipped", reason: "agent has no live channel" };

  const sent = await deliverSend<{ messageId: string }>(
    channel,
    item.conversationId,
    agentId,
    channelConversation.chatId,
    { card: buildApprovalCard(kind, item) }
  );
  // Registered so the card can be settled when the decision is taken somewhere
  // else — on the web. Without it the room keeps a card whose buttons only say
  // "already handled" once pressed, which is the same defect the question card
  // had.
  getPostedApprovals().set(item.id, {
    chatId: channelConversation.chatId,
    messageId: sent.messageId,
    agentId,
    kind,
    item
  });
  console.info(`[feishu] asked for ${kind} approval in ${channelConversation.chatId} (${sent.messageId})`);
  return { status: "posted", chatId: channelConversation.chatId };
}

/**
 * Post a question whenever one is asked.
 *
 * Subscribes once per process, like the other channel subscriptions: a second
 * would ask the same question twice in the room.
 */
/**
 * Settle the room's copy of a question once it is answered or abandoned —
 * wherever that happened.
 *
 * The web UI can answer first, or the run can be cancelled. Either way the
 * buttons in the group must stop looking live, and the buffer of partial
 * answers must not be left behind: it is keyed by pending id and nothing else
 * ever removes it, so a user who answered one question of three and gave up
 * would leave an entry for the life of the process.
 */
async function settlePostedCard(
  pendingId: string,
  state: { answered?: Record<string, string>; cancelled?: boolean }
): Promise<void> {
  // The buffer is always cleared, paused or not: it is local state, and holding
  // it would leak. Only the outbound half is subject to the pause.
  getAnswerBuffer().delete(pendingId);
  if (isChannelProjectionPaused()) return;

  const card = getPostedCards().get(pendingId);
  if (!card) return;
  getPostedCards().delete(pendingId);

  const channel = getFeishuChannelForAgent(card.agentId);
  if (!channel) return;
  await deliverCardUpdate(
    channel,
    card.question.conversationId,
    card.agentId,
    card.messageId,
    buildQuestionCard(card.question, {
      answered: state.answered ?? {},
      cancelled: state.cancelled === true
    })
  );
}

/** Settle the room's approval card once the decision has been taken anywhere. */
async function settlePostedApproval(
  pendingId: string,
  decision: "approve" | "reject"
): Promise<void> {
  if (isChannelProjectionPaused()) return;

  const card = getPostedApprovals().get(pendingId);
  if (!card) return;
  getPostedApprovals().delete(pendingId);

  const channel = getFeishuChannelForAgent(card.agentId);
  if (!channel) return;
  await deliverCardUpdate(
    channel,
    card.item.conversationId,
    card.agentId,
    card.messageId,
    buildApprovalCard(card.kind, card.item, { decision })
  );
}

export function startChannelInteractions(): () => void {
  if (globalThis.__agentMeldChannelInteractionStop) return globalThis.__agentMeldChannelInteractionStop;

  const stop = eventBus.subscribe((entry) => {
    const event = entry.event;
    const post = (work: Promise<unknown>, what: string) =>
      void work.catch((error: unknown) => console.error(`[feishu] failed to post ${what}:`, error));

    if (event.type === "ask_user.pending") {
      post(projectPendingQuestion(event.pendingQuestion), "a question");
      return;
    }
    if (event.type === "dispatch.plan.pending") {
      post(projectPendingApproval("plan", event.pendingPlan), "a plan approval");
      return;
    }
    if (event.type === "bash_command.pending") {
      post(projectPendingApproval("bash", event.pendingCommand), "a command approval");
      return;
    }
    if (event.type === "fs_write.pending") {
      post(projectPendingApproval("write", event.pendingWrite), "a write approval");
      return;
    }
    if (event.type === "ask_user.answered") {
      post(settlePostedCard(event.pendingId, { answered: event.answers }), "a settled question");
      return;
    }
    if (event.type === "ask_user.cancelled") {
      post(settlePostedCard(event.pendingId, { cancelled: true }), "a cancelled question");
      return;
    }
    if (event.type === "dispatch.plan.resolved" || event.type === "bash_command.resolved") {
      post(settlePostedApproval(event.pendingId, event.approved ? "approve" : "reject"), "a decision");
      return;
    }
    if (event.type === "fs_write.resolved") {
      post(settlePostedApproval(event.pendingId, event.applied ? "approve" : "reject"), "a decision");
    }
  });

  globalThis.__agentMeldChannelInteractionStop = stop;
  return stop;
}

export function stopChannelInteractionsForTests(): void {
  globalThis.__agentMeldChannelInteractionStop?.();
  globalThis.__agentMeldChannelInteractionStop = undefined;
  globalThis.__agentMeldChannelAnswers = undefined;
  globalThis.__agentMeldChannelCards = undefined;
  globalThis.__agentMeldChannelApprovalCards = undefined;
}
