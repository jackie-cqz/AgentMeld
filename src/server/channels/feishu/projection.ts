import { eventBus, type EventBusEntry } from "@/server/event-bus";
import { getChannelConversationByConversationId, getMessage, getRun } from "@/server/repositories";
import { getFeishuChannelForAgent } from "@/server/channels/feishu/registry";
import type { AgentRun, Message, MessagePart } from "@/shared/types";

/**
 * Outbound projection: what an agent produced in a conversation also appears in
 * the chat that conversation speaks to, posted by **that agent's own bot**.
 *
 * The per-agent identity is the whole point of binding one app per agent, so
 * there is deliberately no fallback to somebody else's bot: an agent with no
 * connection is silent, not misattributed.
 *
 * This module only ever reads what AgentMeld already decided and puts it in the
 * room. It does not decide anything, and — the other half of §5.8 — it is driven
 * by local state, never by an inbound message.
 */

/**
 * Rolling ceiling on how much one conversation may post.
 *
 * This is a RATE LIMIT, not the hard stop design §5.8 layer 4 described. A
 * runaway is slowed to this rate and resumes by itself when the window rolls —
 * it is never stopped, and nothing needs resetting. Two consequences worth
 * knowing: a conversation that legitimately produces more than this within a
 * minute is cut off mid-task with a single notice, and because a conductor's
 * child tasks share the conversation, a handful of tasks with retries can
 * exhaust it — the summary that gets swallowed can be the conductor's own.
 */
const SEND_WINDOW_MS = 60_000;
const MAX_SENDS_PER_WINDOW = 20;

/**
 * What of a message is fit for the room.
 *
 * Text and code are the answer; an artifact reference becomes a label naming it
 * — **not a link**, because an artifact has no URL a chat member could open.
 * Design §5.6 wanted an actual entry point; this does not provide one.
 *
 * Everything else — reasoning, tool calls and their results, deployment
 * internals, raw attachments — stays on the web, which is where the detail
 * belongs. A message that is only tool calls therefore projects to nothing,
 * which is correct: the group should see conclusions, not a transcript.
 *
 * Deliberately NOT implemented, from review: a reply that FAILED is not posted,
 * so a failure shows up only as "no answer arrived". §5.6 and §5.8 both say a
 * failure should be announced; they are right and this does not do it. Deploy
 * and delivery messages are `role: "system"` and are filtered out for the same
 * reason, so §5.6's delivery half is unimplemented too.
 */
export function projectableText(parts: MessagePart[]): string {
  const chunks: string[] = [];
  for (const part of parts) {
    if (part.type === "text" && part.content.trim()) chunks.push(part.content);
    else if (part.type === "code" && part.content.trim()) chunks.push("```\n" + part.content + "\n```");
    else if (part.type === "artifact_ref") chunks.push(`📎 ${part.title ?? "产物"}`);
  }
  return chunks.join("\n\n").trim();
}

export type ProjectionOutcome =
  | { status: "sent"; chatId: string; agentId: string }
  | { status: "skipped"; reason: string };

declare global {
  var __agentMeldChannelProjectionStop: (() => void) | undefined;
  var __agentMeldChannelProjectionPaused: boolean | undefined;
  var __agentMeldProjectionSendLog: Map<string, number[]> | undefined;
  var __agentMeldProjectionNotices: Set<string> | undefined;
  var __agentMeldProjectionProjectedMessages: Set<string> | undefined;
}

/**
 * Stop everything going out, without touching recording or inbound.
 *
 * Reached through `POST /api/channels/feishu/projection`. The flag is in memory,
 * so a restart resumes projection — the right failure direction for a switch
 * meant to stop an incident fast, but it does mean the pause is not durable.
 */
export function setChannelProjectionPaused(paused: boolean): void {
  globalThis.__agentMeldChannelProjectionPaused = paused;
}

export function isChannelProjectionPaused(): boolean {
  return globalThis.__agentMeldChannelProjectionPaused === true;
}

function getSendLog(): Map<string, number[]> {
  globalThis.__agentMeldProjectionSendLog ??= new Map<string, number[]>();
  return globalThis.__agentMeldProjectionSendLog;
}

function getNotices(): Set<string> {
  globalThis.__agentMeldProjectionNotices ??= new Set<string>();
  return globalThis.__agentMeldProjectionNotices;
}

function getProjectedMessages(): Set<string> {
  globalThis.__agentMeldProjectionProjectedMessages ??= new Set<string>();
  return globalThis.__agentMeldProjectionProjectedMessages;
}

/**
 * Whether this conversation may post right now, given the rolling window.
 *
 * Exported so the limit is testable without waiting a minute.
 */
export function withinSendBudget(conversationId: string, now: number): boolean {
  const log = getSendLog();
  const recent = (log.get(conversationId) ?? []).filter((at) => now - at < SEND_WINDOW_MS);
  log.set(conversationId, recent);
  return recent.length < MAX_SENDS_PER_WINDOW;
}

export function recordSend(conversationId: string, now: number): void {
  const log = getSendLog();
  log.set(conversationId, [...(log.get(conversationId) ?? []), now]);
}

/** Say something once per key. Used for the notices nobody needs twice. */
async function noticeOnce(
  key: string,
  send: () => Promise<unknown>
): Promise<void> {
  const notices = getNotices();
  if (notices.has(key)) return;
  notices.add(key);
  try {
    await send();
  } catch {
    // The notice is a courtesy; failing to deliver it changes nothing.
  }
}

/**
 * Tell the group a run did not finish.
 *
 * §5.6 and §5.8 both ask for this and neither was implemented: a failure was
 * only visible as "no answer arrived", which in a chat is indistinguishable
 * from being ignored.
 *
 * Two deliberate choices:
 *
 * - The reason is NOT posted. An error string routinely carries environment
 *   variable names, file paths and provider internals — the same detail that
 *   should not reach a room from a reply — and a group cannot act on it anyway.
 * - The send budget does not apply. Failures are bounded by the number of runs
 *   and announced once each, and the moment a failure notice is suppressed for
 *   being the twenty-first message is the moment it is most needed. The pause
 *   switch still applies, because that is an explicit instruction to stop.
 */
export async function projectRunFailure(run: AgentRun): Promise<ProjectionOutcome> {
  if (isChannelProjectionPaused()) return { status: "skipped", reason: "paused" };

  // Checked here as well as at the subscription. Without it, excluding aborts
  // rests entirely on one line in the subscriber, and a test that removes that
  // line stays green as long as its fixture has no run row — which is exactly
  // what happened.
  if (run.status !== "failed") return { status: "skipped", reason: "run did not fail" };

  const channelConversation = getChannelConversationByConversationId(run.conversationId);
  if (!channelConversation) return { status: "skipped", reason: "conversation is not on a channel" };

  const channel = getFeishuChannelForAgent(run.agentId);
  if (!channel) return { status: "skipped", reason: "agent has no live channel" };

  const notices = getNotices();
  const key = `run-failed:${run.id}`;
  if (notices.has(key)) return { status: "skipped", reason: "already announced" };
  notices.add(key);

  const result = await channel.send(channelConversation.chatId, {
    text: "⚠️ 这次任务没能完成。详情请在 AgentMeld 网页查看。"
  });
  console.info(
    `[feishu] announced failure of ${run.id} -> ${channelConversation.chatId} (${result.messageId})`
  );
  return { status: "sent", chatId: channelConversation.chatId, agentId: run.agentId };
}

export async function projectMessage(message: Message, now = Date.now()): Promise<ProjectionOutcome> {
  if (isChannelProjectionPaused()) return { status: "skipped", reason: "paused" };

  // Only agent output. A human's message is already where the human put it, and
  // there is no bot that could deliver it as itself.
  if (message.role !== "agent" || !message.agentId) {
    return { status: "skipped", reason: "not agent output" };
  }

  const channelConversation = getChannelConversationByConversationId(message.conversationId);
  if (!channelConversation) return { status: "skipped", reason: "conversation is not on a channel" };

  const channel = getFeishuChannelForAgent(message.agentId);
  if (!channel) {
    // No fallback to another agent's bot: being misattributed is worse than
    // being absent, and per-agent identity is the reason for binding one app
    // per agent at all. The web UI already shows this agent's connection state,
    // so its output being web-only is visible rather than mysterious.
    return { status: "skipped", reason: "agent has no live channel" };
  }

  const text = projectableText(message.parts);
  if (!text) return { status: "skipped", reason: "nothing projectable" };

  // One post per message. `message.end` is not guaranteed to be seen exactly
  // once, and until this existed the only thing standing between a repeat and a
  // duplicate post in the room was that nothing happened to repeat it.
  const projected = getProjectedMessages();
  if (projected.has(message.id)) return { status: "skipped", reason: "already projected" };
  projected.add(message.id);

  if (!withinSendBudget(message.conversationId, now)) {
    // The budget is the backstop for a runaway, so it must be visible rather
    // than silently swallowing output.
    await noticeOnce(`${channelConversation.id}:budget`, () =>
      channel.send(channelConversation.chatId, {
        // Not "paused": the window rolls and sending resumes on its own.
        text: "本会话短时间内的消息过多，部分内容未发送。详情请在 AgentMeld 网页查看。"
      })
    );
    return { status: "skipped", reason: "send budget exhausted" };
  }

  const result = await channel.send(channelConversation.chatId, { text });
  recordSend(message.conversationId, now);
  // Logged because this is the one place in the channel that has an effect
  // outside the process. "Did it actually post?" has to be answerable from the
  // server log, and the platform's own delivery receipts are not readable with
  // the scopes a one-click app is granted.
  console.info(
    `[feishu] projected ${message.agentId} -> ${channelConversation.chatId} (${result.messageId})`
  );
  return { status: "sent", chatId: channelConversation.chatId, agentId: message.agentId };
}

/**
 * Start projecting. Subscribes once per process — a second subscription would
 * post everything twice, and the room would notice.
 */
export function startChannelProjection(): () => void {
  if (globalThis.__agentMeldChannelProjectionStop) return globalThis.__agentMeldChannelProjectionStop;

  const stop = eventBus.subscribe((entry: EventBusEntry) => {
    const event = entry.event;
    // `message.end`, not `message.added`. An agent's answer is created with
    // `message.start` while streaming and finished with `message.end`; it is
    // never published as `message.added` at all (the one `message.added` the
    // runner emits carries a system error notice). Subscribing to the wrong one
    // meant the projection simply never ran — the unit tests could not see it,
    // because they published the event the code was expecting.
    //
    // Waiting for the end is also what makes this aggregated rather than
    // per-token: the runner streams parts into a single message.
    if (event.type === "run.end") {
      // A run that failed produces no reply, so without this the group sees
      // nothing at all and cannot tell a failure from being ignored. "aborted"
      // is not announced: that is the user stopping it, which they know.
      if (event.status !== "failed") return;
      const run = getRun(event.runId);
      if (!run) return;
      void projectRunFailure(run).catch((error: unknown) => {
        console.error("[feishu] failed to announce a run failure:", error);
      });
      return;
    }

    if (event.type !== "message.end") return;
    const message = getMessage(event.messageId);
    if (!message || message.role !== "agent") return;
    // An errored reply is not an answer worth posting; the run-level failure
    // above is what tells the group instead. Note that an ABORTED run is
    // normalised to "complete" downstream, so a reply the user stopped halfway
    // IS posted and looks like a finished answer.
    if ((event.status ?? message.status) !== "complete") return;
    void projectMessage(message).catch((error: unknown) => {
      console.error("[feishu] failed to project a message:", error);
    });
  });

  globalThis.__agentMeldChannelProjectionStop = stop;
  return stop;
}

export function stopChannelProjectionForTests(): void {
  globalThis.__agentMeldChannelProjectionStop?.();
  globalThis.__agentMeldChannelProjectionStop = undefined;
  globalThis.__agentMeldChannelProjectionPaused = undefined;
  globalThis.__agentMeldProjectionSendLog = undefined;
  globalThis.__agentMeldProjectionNotices = undefined;
  globalThis.__agentMeldProjectionProjectedMessages = undefined;
}
