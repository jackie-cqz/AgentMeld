import { abortRun } from "@/server/agent-runner";
import { eventBus } from "@/server/event-bus";
import {
  getChannelBindingForAgent,
  getChannelConversationByConversationId,
  getRun,
  isTerminalRunStatus,
  listRuns
} from "@/server/repositories";
import { getAllPendingQuestions } from "@/server/pending-questions";
import { getAllPendingBashCommands } from "@/server/pending-bash";
import { getAllPendingWrites } from "@/server/pending-writes";
import { getAllPendingPlans } from "@/server/dispatch-plan-manager";
import { listConsultations } from "@/server/collaboration/consultations";
import { escapeLarkMd, withVersion } from "@/server/channels/feishu/card-text";
import {
  getFeishuChannelForAgent,
  listFeishuConnections
} from "@/server/channels/feishu/registry";
import {
  isChannelProjectionPaused,
  recordSend,
  withinSendBudget
} from "@/server/channels/feishu/projection";
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
  /** Which rewrite of the card is on screen; see `withVersion`. */
  version: number;
}

declare global {
  var __agentMeldChannelRunCards: Map<string, RunCard> | undefined;
  var __agentMeldChannelProgressStop: (() => void) | undefined;
  var __agentMeldChannelRunCardWork: Map<string, Promise<unknown>> | undefined;
}

/**
 * Updates to ONE card, one after another.
 *
 * A status refresh and the settle that closes the card are both PATCHes of the
 * same message, issued from different events. If a refresh is still in flight
 * when the run ends, its response can land after the settle's and put a
 * live-looking card back over a finished one — with a cancel button on it.
 * Queued per run, the settle always follows whatever was already on its way, and
 * anything queued after it finds the card gone from the registry and does
 * nothing.
 */
function enqueueCardWork<T>(runId: string, work: () => Promise<T>): Promise<T> {
  globalThis.__agentMeldChannelRunCardWork ??= new Map<string, Promise<unknown>>();
  const chains = globalThis.__agentMeldChannelRunCardWork;
  const previous = chains.get(runId) ?? Promise.resolve();
  // A failure earlier in the chain must not stop later work from running.
  const next = previous.catch(() => undefined).then(work);
  chains.set(runId, next);
  void next
    .catch(() => undefined)
    .finally(() => {
      if (chains.get(runId) === next) chains.delete(runId);
    });
  return next;
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

/** What a conductor run is doing, in words the room can read. */
const STAGE_LABEL: Record<string, string> = {
  dispatch: "正在执行各个任务",
  recovery: "正在为失败的任务重新规划",
  aggregate: "正在汇总结果",
  planning: "正在规划任务",
  awaiting_approval: "等待计划审批",
  discussion: "讨论中",
  "execution.queued": "等待执行资源",
  execution: "正在执行",
  "admission.received": "已接收消息",
  "admission.classifying": "正在判断消息处理方式",
  "admission.followup": "补充已排队，等待生效",
  "admission.stopping": "等待旧执行停止",
  "admission.waiting": "等待上一项工作结束",
  handoff: "正在交接任务"
};

/**
 * A stage as the room should read it.
 *
 * The stage values are internal tokens ("dispatch"), and the card used to show
 * them raw. An unknown stage is shown escaped rather than hidden, so a new one
 * appears as itself until someone gives it a label.
 */
export function stageLabel(stage: string | null): string | null {
  if (!stage) return null;
  return STAGE_LABEL[stage] ?? escapeLarkMd(stage);
}

export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  if (total < 60) return `${total} 秒`;
  if (total < 3600) return `${Math.floor(total / 60)} 分 ${total % 60} 秒`;
  return `${Math.floor(total / 3600)} 小时 ${Math.floor((total % 3600) / 60)} 分`;
}

/** A reading of a run, taken when someone asked. */
export interface RunStatusSnapshot {
  run: AgentRun;
  now: number;
  children: Record<AgentRunStatus, number>;
  childTotal: number;
  /** Things this run is waiting on a person for — its own and its children's. */
  waiting: { questions: number; approvals: number; colleagues?: number };
}

/**
 * Take a reading of a run: its state, its children's, and what is waiting on a
 * person.
 *
 * Children are the direct child runs, which is the conductor's task runs. What
 * is waiting counts the run's own pendings AND its children's, because a plan
 * task asking a question is the run waiting, as far as the room is concerned.
 */
export function collectRunStatus(run: AgentRun, now = Date.now()): RunStatusSnapshot {
  const children = listRuns(run.conversationId).filter((candidate) => candidate.parentRunId === run.id);
  const counts: Record<AgentRunStatus, number> = {
    queued: 0,
    running: 0,
    complete: 0,
    failed: 0,
    aborted: 0
  };
  for (const child of children) counts[child.status] += 1;

  const owned = new Set([run.id, ...children.map((child) => child.id)]);
  const questions = getAllPendingQuestions().filter((item) => owned.has(item.runId)).length;
  const approvals =
    getAllPendingPlans().filter((item) => owned.has(item.runId)).length +
    getAllPendingBashCommands().filter((item) => owned.has(item.runId)).length +
    getAllPendingWrites().filter((item) => owned.has(item.runId)).length;

  const colleagues = listConsultations(run.conversationId).filter(item => owned.has(item.sourceRunId) && ["requested", "running"].includes(item.status)).length;
  return { run, now, children: counts, childTotal: children.length, waiting: { questions, approvals, ...(colleagues ? { colleagues } : {}) } };
}

/**
 * The lines a status reading comes to. Pure, so the wording is pinned without a
 * platform round trip. Nothing here is model-authored, which is why none of it
 * needs escaping — the one exception, an unfamiliar stage, is escaped in
 * `stageLabel`.
 */
export function describeRunStatus(snapshot: RunStatusSnapshot): string[] {
  const { run, now, children, childTotal, waiting } = snapshot;
  const finished = isTerminalRunStatus(run.status);
  const lines: string[] = [];

  lines.push(`${finished ? "用时" : "已运行"} ${formatElapsed((run.finishedAt ?? now) - run.startedAt)}`);

  const stage = stageLabel(run.stage);
  if (stage && !finished) lines.push(stage);

  if (childTotal > 0) {
    const parts = [`完成 ${children.complete}`, `进行中 ${children.running}`];
    if (children.queued) parts.push(`排队 ${children.queued}`);
    if (children.failed) parts.push(`失败 ${children.failed}`);
    if (children.aborted) parts.push(`已取消 ${children.aborted}`);
    lines.push(`子任务 ${childTotal} 个：${parts.join(" · ")}`);
  }

  const waits: string[] = [];
  if (waiting.questions) waits.push(`${waiting.questions} 个提问`);
  if (waiting.approvals) waits.push(`${waiting.approvals} 项审批`);
  if (waits.length) lines.push(`等待处理：${waits.join("、")}`);
  if (waiting.colleagues) lines.push(`等待同事回复：${waiting.colleagues} 项咨询`);

  return lines;
}

/** How the card reads. Pure, so its shape is pinned without a platform round trip. */
export function buildProgressCard(
  run: AgentRun,
  agentName: string | null,
  ended?: AgentRunStatus,
  snapshot?: RunStatusSnapshot,
  version = 0
): object {
  const status = ended ?? run.status;
  const finished = ended !== undefined;
  const who = agentName ?? run.agentId;

  // A settled card says how long it took and nothing about what it is "doing":
  // the stage of a finished run would read as present tense on a card that is
  // over. A live card shows a reading when one was taken, and otherwise only the
  // stage, which is all the start event carried.
  const lines = finished
    ? run.finishedAt !== null
      ? [`用时 ${formatElapsed(run.finishedAt - run.startedAt)}`]
      : []
    : snapshot
      ? describeRunStatus(snapshot)
      : [stageLabel(run.stage)].filter((line): line is string => Boolean(line));

  return {
    config: { wide_screen_mode: true },
    header: {
      template: status === "failed" ? "red" : status === "aborted" ? "grey" : finished ? "green" : "blue",
      title: { tag: "plain_text", content: `「${who}」${STATUS_TEXT[status]}` }
    },
    elements: [
      ...(lines.length ? [{ tag: "div", text: { tag: "lark_md", content: lines.join("\n") } }] : []),
      // The buttons exist only while there is something to ask about or cancel.
      // A finished run offering either would be a lie the click has to correct.
      ...(finished
        ? []
        : [
            {
              tag: "action",
              actions: [
                {
                  tag: "button",
                  text: { tag: "plain_text", content: "查看状态" },
                  type: "default",
                  value: withVersion({ kind: "run_status", runId: run.id }, version)
                },
                {
                  tag: "button",
                  text: { tag: "plain_text", content: "取消运行" },
                  type: "danger",
                  value: withVersion({ kind: "cancel_run", runId: run.id }, version)
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

  // Sent and REGISTERED as one unit, on the card's work queue. The registry
  // entry used to be written only after the send resolved, so a run that failed
  // during those milliseconds produced a settle that found no card and quietly
  // returned — leaving the room a card that said "running" forever, with a
  // cancel button on it. On the queue, a settle that arrives mid-send waits,
  // and finds the card.
  return enqueueCardWork(run.id, async () => {
    // The run may have ended while this waited its turn. Posting a card for a
    // run that is already over is exactly the stale card the queue exists to
    // prevent.
    const current = getRun(run.id);
    if (current && isTerminalRunStatus(current.status)) {
      return { status: "skipped" as const, reason: "run already ended" };
    }

    const sent = await deliverSend<{ messageId: string }>(
      channel,
      run.conversationId,
      run.agentId,
      channelConversation.chatId, {
      card: buildProgressCard(run, agentName)
    });
    // Spend the budget the check above consulted. The card checked but never
    // recorded, so a burst of progress cards neither counted against the
    // conversation's allowance nor was stopped by it.
    recordSend(run.conversationId, Date.now());
    getRunCards().set(run.id, {
      version: 0,
      chatId: channelConversation.chatId,
      messageId: sent.messageId,
      agentId: run.agentId,
      agentName
    });
    return { status: "posted" as const, chatId: channelConversation.chatId };
  });
}

/**
 * Close the card a run opened.
 *
 * Also removes it from the registry: the card is finished, and keeping it would
 * leave a cancel button reachable through a stale entry.
 */
export function settleRunCard(run: AgentRun, status?: AgentRunStatus): Promise<void> {
  // Queued behind anything already updating this card; see `enqueueCardWork`.
  return enqueueCardWork(run.id, () => settleNow(run, status));
}

async function settleNow(run: AgentRun, status?: AgentRunStatus): Promise<void> {
  // Updating a card is outbound, so the pause switch applies to it like
  // anything else. A card left unsettled while paused is the correct outcome:
  // the room is meant to stop changing.
  if (isChannelProjectionPaused()) return;

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

/**
 * Rewrite the card with a fresh reading.
 *
 * Does nothing once the card has been settled — a refresh that arrives after the
 * run ended must not put a live-looking card, buttons and all, back over a
 * finished one. The pause switch applies, because this is outbound.
 */
export function refreshRunCard(run: AgentRun, snapshot: RunStatusSnapshot): Promise<void> {
  return enqueueCardWork(run.id, async () => {
    if (isChannelProjectionPaused()) return;

    const card = getRunCards().get(run.id);
    if (!card) return;

    const channel = getFeishuChannelForAgent(card.agentId);
    if (!channel) return;

    // The next version goes out with this rewrite and is recorded only once the
    // platform has accepted it. Recording it first would leave a card on screen
    // carrying a version the next click was never told about.
    const next = card.version + 1;
    await deliverCardUpdate(
      channel,
      run.conversationId,
      card.agentId,
      card.messageId,
      buildProgressCard(run, card.agentName, undefined, snapshot, next)
    );
    card.version = next;
  });
}

/**
 * Answer a click on the status button.
 *
 * Read-only, so it asks for no owner check — a deliberate decision, and worth
 * stating precisely: the child-task counts and the waiting counts are NOT
 * otherwise in the room, they were web-only. What a member learns is counts
 * without content; acting on the run — cancelling — still needs the owner. If
 * that trade ever stops being acceptable, this is the check to tighten.
 * The click must come from the chat the card belongs to, failing closed when the
 * mapping is missing, like every other card action.
 *
 * It answers at once with a toast and refreshes the shared card in the
 * background. A card callback has to be answered quickly and must never wait on
 * the platform (§5.4), and rewriting the card through the update API keeps the
 * room looking at one card rather than relying on whether a callback response
 * is shown to the clicker alone or to everyone.
 */
export function handleRunStatusClick(input: {
  runId: string;
  chatId: string | undefined;
  now?: number;
}): Record<string, unknown> {
  const run = getRun(input.runId);
  if (!run) return { toast: { type: "info", content: "这次运行已经结束了。" } };

  const where = getChannelConversationByConversationId(run.conversationId);
  if (!where || where.chatId !== input.chatId) {
    return { toast: { type: "error", content: "这张卡片不属于这个群。" } };
  }

  if (isTerminalRunStatus(run.status)) {
    return { toast: { type: "info", content: `这次运行${STATUS_TEXT[run.status]}。` } };
  }

  const snapshot = collectRunStatus(run, input.now);
  void refreshRunCard(run, snapshot).catch((error: unknown) => {
    console.error("[feishu] failed to refresh a run card:", error);
  });

  return {
    toast: { type: "info", content: [STATUS_TEXT[run.status], ...describeRunStatus(snapshot)].join(" · ") }
  };
}

export type CancelOutcome = { ok: true } | { ok: false; message: string };

/**
 * Cancel a run from its card.
 *
 * Authorised to the binding owner for the same reason approvals are: a group is
 * where people who are not the owner are present, and cancelling somebody
 * else's work is not a spectator action.
 */
export function cancelRunFromCard(
  runId: string,
  operatorOpenId: string | undefined,
  agentId: string,
  deliveringAppId: string | undefined
): CancelOutcome {
  const binding = getChannelBindingForAgent(agentId, "feishu");
  if (!binding?.boundByOpenId || binding.boundByOpenId !== operatorOpenId) {
    return { ok: false, message: "只有绑定这个应用的账号可以取消。" };
  }
  // The app that delivered this click, the same rule the question and approval
  // cards follow: an open_id is only meaningful inside the app that issued it,
  // so a click arriving through an app the agent is no longer bound to is a
  // different person's word even when the string matches. Cancelling is
  // owner-gated, so it needs the same app dimension.
  if (binding.appId !== deliveringAppId) {
    return { ok: false, message: "这张卡片来自已经不生效的应用，请重新发起。" };
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
  globalThis.__agentMeldChannelRunCardWork = undefined;
}
