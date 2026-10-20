import { getDatabase } from "@/db/client";
import { eventBus } from "@/server/event-bus";
import { getMessage, getRun, listRuns, updateRunStage } from "@/server/repositories";
import { getTaskAttemptByChildRun } from "@/server/repositories/evidence-repository";
import { loadActiveFacts } from "@/server/context-facts/fact-service";
import { extractFactsForUserTurn } from "@/server/context-facts/conductor-fact-extraction";
import { submitPiFollowup, type PiFollowupReceipt } from "@/server/pi/controls";
import { PiRuntimeError } from "@/server/pi/process";
import type { HarnessInvocationInput } from "@/server/harness/types";
import type { AgentRun } from "@/shared/types";
import type { CollaborationAction, CollaborationTurn } from "@/shared/collaboration-types";
import { classifyHumanTurn } from "./turn-classifier";
import { createCollaborationTurn, listCollaborationTurns, updateCollaborationTurn } from "./turns";

export interface TurnControls {
  stop: (runId: string) => boolean;
  waitForStop: (runId: string, signal: AbortSignal) => Promise<void>;
}
export type TurnAdmission =
  | { handled: true; response?: string; turnId: string }
  | { handled: false; mode: "discussion" | "execution"; contextText?: string; turnId: string; onAccepted: () => void };

const admissionChains = new Map<string, Promise<void>>();
async function inAdmissionOrder<T>(key: string, signal: AbortSignal, work: () => Promise<T>): Promise<T> {
  const previous = admissionChains.get(key) ?? Promise.resolve();
  let release!: () => void;
  const own = new Promise<void>(resolve => { release = resolve; });
  const tail = previous.then(() => own, () => own);
  admissionChains.set(key, tail);
  try {
    await new Promise<void>((resolve, reject) => {
      const onAbort = () => reject(signal.reason);
      signal.addEventListener("abort", onAbort, { once: true });
      previous.then(() => { signal.removeEventListener("abort", onAbort); resolve(); }, error => { signal.removeEventListener("abort", onAbort); reject(error); });
      if (signal.aborted) onAbort();
    });
    signal.throwIfAborted();
    return await work();
  } finally {
    release();
    void tail.then(() => { if (admissionChains.get(key) === tail) admissionChains.delete(key); });
  }
}

export function publishRunStage(run: AgentRun, stage: string): void {
  updateRunStage(run.id, stage, Date.now());
  eventBus.publish({ type: "run.stage", conversationId: run.conversationId, timestamp: Date.now(), runId: run.id, stage });
}

function rootRun(target: AgentRun): AgentRun {
  const seen = new Set<string>();
  let root = target;
  while (root.parentRunId) {
    if (seen.has(root.id) || seen.size >= 16) throw new Error("Invalid run lineage.");
    seen.add(root.id);
    const parent = getRun(root.parentRunId);
    if (!parent || parent.conversationId !== target.conversationId) throw new Error("Run lineage crosses a conversation boundary.");
    root = parent;
  }
  return root;
}

function relatedRuns(input: HarnessInvocationInput, explicitTarget?: string): AgentRun[] {
  const parent = input.triggerMessage.parentMessageId ? getMessage(input.triggerMessage.parentMessageId) : null;
  const replyRun = parent?.runId ? getRun(parent.runId) : null;
  const candidates = listRuns(input.conversationId).filter(run => run.id !== input.runId &&
    !["admission.classifying", "admission.received"].includes(run.stage ?? "") && input.conversation.agentIds.includes(run.agentId) &&
    (input.agent.isConductor || run.agentId === input.agent.id)).slice(-20);
  if (replyRun && replyRun.conversationId === input.conversationId && input.conversation.agentIds.includes(replyRun.agentId) &&
    (input.agent.isConductor || replyRun.agentId === input.agent.id) && !candidates.some(run => run.id === replyRun.id)) candidates.push(replyRun);
  const explicit = explicitTarget ? getRun(explicitTarget) : null;
  if (explicit && explicit.id !== input.runId && explicit.conversationId === input.conversationId && input.conversation.agentIds.includes(explicit.agentId) &&
    (input.agent.isConductor || explicit.agentId === input.agent.id) && !candidates.some(run => run.id === explicit.id)) candidates.push(explicit);
  return candidates;
}

function snapshotFor(input: HarnessInvocationInput, target: AgentRun | null, objective?: string): string {
  const attempt = target ? getTaskAttemptByChildRun(target.id) : undefined;
  return JSON.stringify({
    sourceMessageId: input.triggerMessage.id, sourceRunId: target?.id ?? null,
    sourceTask: attempt ? { conductorRunId: attempt.conductorRunId, planId: attempt.planId, taskId: attempt.taskId, attemptId: attempt.id, attempt: attempt.attempt, contextSnapshotId: attempt.contextSnapshotId } : null,
    objective: objective ?? null,
    facts: loadActiveFacts(input.conversationId).map(fact => ({ id: fact.id, key: fact.canonicalKey, value: fact.value, trust: fact.trustLevel, updatedAt: fact.updatedAt })),
  });
}

function retireContextForCorrection(target: AgentRun): void {
  const root = rootRun(target);
  const now = Date.now();
  // Historical snapshots/reports stay immutable. Only their applicability to
  // a new execution and the downstream binding eligibility are retired.
  getDatabase().prepare("UPDATE conductor_output_bindings SET superseded_at=COALESCE(superseded_at,?) WHERE conductor_run_id=?").run(now, root.id);
  getDatabase().prepare("UPDATE task_evidence SET status='stale',invalidated_at=? WHERE conductor_run_id=? AND invalidated_at IS NULL").run(now, root.id);
}

export async function admitHumanTurn(input: HarnessInvocationInput, run: AgentRun, signal: AbortSignal, controls: TurnControls,
  override?: { action?: CollaborationAction; targetRunId?: string }): Promise<TurnAdmission> {
  const turn = createCollaborationTurn(run, input.triggerMessage);
  publishRunStage(run, "admission.received");
  updateCollaborationTurn(turn.id, { status: "classifying" });
  let related: AgentRun[] = [];
  let decision: Awaited<ReturnType<typeof classifyHumanTurn>>;
  const classify = async () => {
    publishRunStage(run, "admission.classifying");
    related = relatedRuns(input, override?.targetRunId);
    return classifyHumanTurn(input, related, signal, override?.action, override?.targetRunId);
  };
  try {
    decision = override?.action === "progress" || override?.action === "cancel" ? await classify()
      : await inAdmissionOrder(`${input.conversationId}:${input.agent.id}`, signal, classify);
  }
  catch (error) {
    signal.throwIfAborted();
    // An engine that is not registered for this Agent is a configuration
    // problem, not an ambiguous message: say so instead of asking the user to
    // re-confirm intent that we could not classify because no engine ran.
    if (error instanceof PiRuntimeError && ["cleanup_failed", "authentication", "configuration", "migration_required", "harness_unavailable"].includes(error.category)) throw error;
    updateCollaborationTurn(turn.id, { intent: "clarify", status: "needs_confirmation", reason: "无法可靠判断这条消息的处理方式，请确认讨论还是执行。" });
    return { handled: true, turnId: turn.id, response: "这条消息尚未开始执行。请确认是继续讨论、开启新任务，还是补充已有任务。" };
  }
  signal.throwIfAborted();
  const live = related.filter(candidate => candidate.status === "running" || candidate.status === "queued");
  const target = decision.targetRunId ? related.find(candidate => candidate.id === decision.targetRunId) ?? null
    : ["progress", "supplement", "correction", "cancel"].includes(decision.intent) && live.length === 1 ? live[0] : null;
  const mode = decision.intent === "discussion" ? "discussion" : decision.intent === "new_task" ? "execution" : decision.mode;
  updateCollaborationTurn(turn.id, { intent: decision.intent, mode, targetRunId: target?.id ?? null, reason: decision.reason });

  const clarify = (reason: string): TurnAdmission => {
    updateCollaborationTurn(turn.id, { status: "needs_confirmation", reason });
    return { handled: true, turnId: turn.id, response: reason };
  };
  const ready = (readyMode: "discussion" | "execution", contextText?: string): TurnAdmission => {
    updateCollaborationTurn(turn.id, { mode: readyMode, status: "queued", context: snapshotFor(input, target, contextText) });
    publishRunStage(run, readyMode === "discussion" ? "discussion" : "execution.queued");
    return { handled: false, mode: readyMode, contextText, turnId: turn.id,
      onAccepted: () => { updateCollaborationTurn(turn.id, { status: "applied", reason: "当前消息已进入 Agent 的任务上下文。" }); } };
  };
  if (decision.intent === "clarify") return clarify("还不能确定是讨论还是执行，或要关联哪项任务。请选择处理方式后继续。");
  if (["progress", "supplement", "correction", "cancel"].includes(decision.intent) && !target) {
    return clarify("存在多项可能关联的工作，请回复对应 Agent 的消息或明确选择运行，避免修改错误的任务。");
  }
  if (decision.intent === "progress" && target) {
    const latest = getRun(target.id)!;
    updateCollaborationTurn(turn.id, { status: "applied", context: snapshotFor(input, latest), reason: "已查询现有运行，未启动新的执行。" });
    return { handled: true, turnId: turn.id, response: `当前工作：${latest.status === "running" ? "运行中" : latest.status === "queued" ? "排队中" : latest.status === "complete" ? "已完成" : latest.status === "aborted" ? "已取消" : "运行失败"}。${latest.stage ? `阶段：${latest.stage}。` : ""}${latest.error ? `原因：${latest.error}` : ""}` };
  }
  if (decision.intent === "cancel" && target) {
    const root = rootRun(target);
    updateCollaborationTurn(turn.id, { status: "queued", reason: "已请求停止，等待执行资源清理确认。", context: snapshotFor(input, target) });
    controls.stop(root.id);
    await controls.waitForStop(root.id, signal);
    updateCollaborationTurn(turn.id, { status: "applied", reason: "关联执行已停止并完成清理。" });
    return { handled: true, turnId: turn.id, response: "关联执行已停止。" };
  }

  const targetTurn = target ? listCollaborationTurns(input.conversationId).find(item => item.runId === target.id) : null;
  if (target && decision.intent === "supplement" && targetTurn && !targetTurn.mode) return clarify("目标消息还在判断处理方式，请等待判断完成后再补充，或明确选择新任务。");
  const targetMode = targetTurn?.mode ?? (target?.stage === "discussion" ? "discussion" : "execution");
  const proceedMode = decision.intent === "supplement" ? targetMode : mode;
  updateCollaborationTurn(turn.id, { mode: proceedMode });
  if (target && (decision.intent === "supplement" || decision.intent === "correction" && mode === "discussion") && targetMode === "discussion") {
    updateCollaborationTurn(turn.id, { status: "queued", context: snapshotFor(input, target), reason: "补充已排队，等待 Pi 确认消费。" });
    publishRunStage(run, "admission.followup");
    let complete!: (receipt: PiFollowupReceipt) => void;
    let rejectConsumed!: (error: unknown) => void;
    const consumed = new Promise<PiFollowupReceipt>((resolve, reject) => { complete = resolve; rejectConsumed = reject; });
    const stopOnAbort = () => controls.stop(target.id);
    signal.addEventListener("abort", stopOnAbort, { once: true });
    try {
      await submitPiFollowup(target.id, { id: turn.id, kind: "steer", text: input.triggerMessage.parts.filter(part => part.type === "text").map(part => part.content).join("\n") }, receipt => {
        try {
          if (receipt.state === "applied") updateCollaborationTurn(turn.id, { status: "applied", reason: "Pi 已确认消费这条补充。" });
          if (receipt.state !== "queued") complete(receipt);
        } catch (error) { rejectConsumed(error); throw error; }
      });
      const result = await consumed;
      signal.throwIfAborted();
      if (result.state === "applied") return { handled: true, turnId: turn.id };
      // Full-tool discussions cannot be assumed read-only. A rejected or
      // unconsumed steer must use the same stop-and-recompile path as a writer.
    } finally { signal.removeEventListener("abort", stopOnAbort); }
  }

  let contextText: string | undefined;
  if (target && (decision.intent === "correction" || decision.intent === "supplement")) {
    const root = rootRun(target);
    updateCollaborationTurn(turn.id, { status: "queued", reason: "执行约束需要重新编译，正在停止旧执行。" });
    publishRunStage(run, "admission.stopping");
    controls.stop(root.id);
    await controls.waitForStop(root.id, signal);
    retireContextForCorrection(target);
    const original = root.triggerMessageId ? getMessage(root.triggerMessageId) : null;
    const oldObjective = original?.parts.filter(part => part.type === "text").map(part => part.content).join("\n") ?? "";
    contextText = JSON.stringify({ previous_goal: oldObjective, latest_human_update: input.triggerMessage.parts.filter(part => part.type === "text").map(part => part.content).join("\n"),
      precedence: "The latest human update and currently active facts override the historical goal. Rebuild the task/plan and obtain required approvals; old execution evidence is not proof for the new attempt." });
  } else if (mode === "execution") {
    // One Agent does not begin a second mutable task while its previous task is
    // still active. Other Agents remain independently available for discussion.
    const previous = live.filter(candidate => candidate.agentId === input.agent.id);
    for (const candidate of previous) {
      updateCollaborationTurn(turn.id, { status: "queued", reason: "已接收新任务，等待该 Agent 的上一项执行结束。" });
      publishRunStage(run, "admission.waiting");
      await controls.waitForStop(rootRun(candidate).id, signal);
    }
  }
  if (proceedMode === "execution") await extractFactsForUserTurn({ conversationId: input.conversationId, conductorRunId: run.id, conductorAgent: input.agent, triggerMessage: input.triggerMessage });
  return ready(proceedMode, contextText);
}

export function rejectUnappliedTurn(runId: string, reason: string, cancelled: boolean): void {
  const row = getDatabase().prepare("SELECT id FROM collaboration_turns WHERE run_id=?").get(runId) as { id: string } | undefined;
  if (row) updateCollaborationTurn(row.id, { status: cancelled ? "cancelled" : "rejected", reason });
}

export function publicCollaborationTurns(conversationId: string): CollaborationTurn[] {
  return listCollaborationTurns(conversationId).map(turn => ({ ...turn, context: null }));
}
