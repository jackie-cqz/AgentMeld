import { abortRun } from "@/server/agent-runner";
import { eventBus } from "@/server/event-bus";
import {
  getChannelBindingForAgent,
  getChannelConversationByConversationId
} from "@/server/repositories";
import {
  getFeishuChannelForAgent,
  listFeishuConnections
} from "@/server/channels/feishu/registry";
import { isChannelProjectionPaused, withinSendBudget } from "@/server/channels/feishu/projection";
import type { AgentRun, AgentRunStatus } from "@/shared/types";
import { deliverSend, deliverCardUpdate } from "@/server/channels/feishu/delivery";

/**
 * A run's progress in the room, as one card that is updated in place.
 *
 * This is §5.6's "one aggregated progress card", and it is also where cancelling
 * lives: a cancel button needs something to hang off, and until now the only
 * card in the room appeared when a run was already over.
 *
 * One card per TOP-LEVEL run. The conductor spawns a child run per task, and a
 * card for each of those would turn a five-task plan into six cards — the noise
 * §5.6 exists to prevent. The child's work is visible through the parent's
 * status instead.
 *
 * The message rate limit applies, because this is the noisy end of the channel.
 * Being throttled costs a progress card, never the run.
 */

interface RunCard {
  chatId: string;
  messageId: string;
  agentId: string;
  agentName: string | null;
}

declare global {
  var __agentMeldChannelRunCards: Map<string, RunCard> | undefined;
  var __agentMeldChannelProgressStop: (() => void) | undefined;
}

function getRunCards(): Map<string, RunCard> {
  globalThis.__agentMeldChannelRunCards ??= new Map<string, RunCard>();
  return globalThis.__agentMeldChannelRunCards;
}

const STATUS_TEXT: Record<AgentRunStatus, string> = {
  queued: "排队中",
  running: "正在处理…",
  complete: "已完成",
  failed: "失败",
  aborted: "已取消"
};

/** How the card reads. Pure, so its shape is pinned without a platform round trip. */
export function buildProgressCard(run: AgentRun, agentName: string | null, ended?: AgentRunStatus): object {
  const status = ended ?? run.status;
  const finished = ended !== undefined;
  const who = agentName ?? run.agentId;

  return {
    config: { wide_screen_mode: true },
    header: {
      template: status === "failed" ? "red" : status === "aborted" ? "grey" : finished ? "green" : "blue",
      title: { tag: "plain_text", content: `「${who}」${STATUS_TEXT[status]}` }
    },
    elements: [
      ...(run.stage ? [{ tag: "div", text: { tag: "lark_md", content: run.stage } }] : []),
      // The cancel button exists only while there is something to cancel. A
      // finished run offering it would be a lie the click would have to correct.
      ...(finished
        ? []
        : [
            {
              tag: "action",
              actions: [
                {
                  tag: "button",
                  text: { tag: "plain_text", content: "取消运行" },
                  type: "danger",
                  value: { kind: "cancel_run", runId: run.id }
                }
              ]
            }
          ])
    ]
  };
}

export type ProgressOutcome =
  | { status: "posted"; chatId: string }
  | { status: "skipped"; reason: string };

/** The agent's name as the room knows it, which is the bot's display name. */
function agentNameFor(agentId: string): string | null {
  return listFeishuConnections().find((connection) => connection.agentId === agentId)?.botName ?? null;
}

export async function projectRunStarted(run: AgentRun): Promise<ProgressOutcome> {
  if (isChannelProjectionPaused()) return { status: "skipped", reason: "paused" };
  // Only top-level runs get a card; see the note above.
  if (run.parentRunId) return { status: "skipped", reason: "child run" };

  const channelConversation = getChannelConversationByConversationId(run.conversationId);
  if (!channelConversation) return { status: "skipped", reason: "conversation is not on a channel" };

  const channel = getFeishuChannelForAgent(run.agentId);
  if (!channel) return { status: "skipped", reason: "agent has no live channel" };

  if (!withinSendBudget(run.conversationId, Date.now())) {
    return { status: "skipped", reason: "send budget exhausted" };
  }

  const agentName = agentNameFor(run.agentId);
  const sent = await deliverSend<{ messageId: string }>(
    channel,
    run.conversationId,
    run.agentId,
    channelConversation.chatId, {
    card: buildProgressCard(run, agentName)
  });
  getRunCards().set(run.id, {
    chatId: channelConversation.chatId,
    messageId: sent.messageId,
    agentId: run.agentId,
    agentName
  });
  return { status: "posted", chatId: channelConversation.chatId };
}

/**
 * Close the card a run opened.
 *
 * Also removes it from the registry: the card is finished, and keeping it would
 * leave a cancel button reachable through a stale entry.
 */
export async function settleRunCard(run: AgentRun, status?: AgentRunStatus): Promise<void> {
  const card = getRunCards().get(run.id);
  if (!card) return;
  getRunCards().delete(run.id);

  const channel = getFeishuChannelForAgent(card.agentId);
  if (!channel) return;
  // The status comes from the EVENT rather than being read back from the row.
  //
  // Worth recording how this arrived: a test asserted the card's text instead of
  // only counting the calls, and it failed, and the commit said the two are not
  // ordered. They are — both producers update the row and then publish. The
  // failure was the test's own fixture, which wrote a run row with status
  // "running" while publishing `run.end` with "complete". The change is kept
  // because the event is the better source of truth for the event, not because
  // a bug was found.
  await deliverCardUpdate(
    channel,
    run.conversationId,
    run.agentId,
    card.messageId,
    buildProgressCard(run, card.agentName, status ?? run.status)
  );
}

export type CancelOutcome = { ok: true } | { ok: false; message: string };

/**
 * Cancel a run from its card.
 *
 * Authorised to the binding owner for the same reason approvals are: a group is
 * where people who are not the owner are present, and cancelling somebody
 * else's work is not a spectator action.
 */
export function cancelRunFromCard(runId: string, operatorOpenId: string | undefined, agentId: string): CancelOutcome {
  const binding = getChannelBindingForAgent(agentId, "feishu");
  if (!binding?.boundByOpenId || binding.boundByOpenId !== operatorOpenId) {
    return { ok: false, message: "只有绑定这个应用的账号可以取消。" };
  }

  const cancelled = abortRun(runId);
  return cancelled ? { ok: true } : { ok: false, message: "这次运行已经结束了。" };
}

/**
 * Follow runs for the rooms they belong to.
 *
 * Subscribes once per process, like the other channel subscriptions.
 */
export function startChannelProgress(): () => void {
  if (globalThis.__agentMeldChannelProgressStop) return globalThis.__agentMeldChannelProgressStop;

  const stop = eventBus.subscribe((entry) => {
    const event = entry.event;
    if (event.type === "run.start") {
      // The event carries ids, not the record; the run is read back so the card
      // reflects what was actually stored.
      void import("@/server/repositories")
        .then(({ getRun }) => {
          const run = getRun(event.runId);
          if (run) return projectRunStarted(run);
          return undefined;
        })
        .catch((error: unknown) => console.error("[feishu] failed to post run progress:", error));
      return;
    }
    if (event.type === "run.end") {
      void import("@/server/repositories")
        .then(({ getRun }) => {
          const run = getRun(event.runId);
          if (run) return settleRunCard(run, event.status);
          return undefined;
        })
        .catch((error: unknown) => console.error("[feishu] failed to settle run progress:", error));
    }
  });

  globalThis.__agentMeldChannelProgressStop = stop;
  return stop;
}

export function stopChannelProgressForTests(): void {
  globalThis.__agentMeldChannelProgressStop?.();
  globalThis.__agentMeldChannelProgressStop = undefined;
  globalThis.__agentMeldChannelRunCards = undefined;
}
