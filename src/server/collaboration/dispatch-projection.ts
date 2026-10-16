import { getDatabase } from "@/db/client";
import { listMessages, listRuns } from "@/server/repositories";
import { getContextSnapshot, listCriterionVerdicts, listEvidenceForAttempt, listTaskAttempts } from "@/server/repositories/evidence-repository";
import type { DispatchPlanItem } from "@/shared/types";
import type { DispatchState } from "@/shared/dispatch-state";

/** Reconstruct display state from durable facts. Never dispatches or resumes execution. */
export function persistedDispatches(conversationId: string): Record<string, DispatchState> {
  const db = getDatabase();
  const plans = db.prepare("SELECT id,conductor_run_id,plan_json FROM conductor_plans WHERE conversation_id=? ORDER BY created_at,rowid").all(conversationId) as Array<{ id: string; conductor_run_id: string; plan_json: string }>;
  const planOrder = new Map(plans.map((plan, index) => [plan.id, index]));
  const messages = listMessages(conversationId), runs = listRuns(conversationId);
  const states: Record<string, DispatchState> = {};
  for (const row of plans) {
    const run = runs.find(run => run.id === row.conductor_run_id);
    if (!run) continue;
    let items: Array<DispatchPlanItem & { prompt?: string }>;
    try { items = JSON.parse(row.plan_json); } catch { continue; }
    if (!Array.isArray(items)) continue;
    const state = states[run.id] ??= { runId: run.id, conversationId,
      messageId: [...messages].reverse().find(message => message.runId === run.id && message.role === "agent")?.id ?? null,
      plan: [], taskStatus: {}, childRunIds: {}, attempts: {}, errors: {}, attemptIdsByTask: {}, activeAttemptByTask: {}, verificationStatusByTask: {},
      contextSummaryByAttempt: {}, evidenceCountByAttempt: {}, verdictSummaryByAttempt: {} };
    for (const item of items) {
      if (!item || typeof item.id !== "string" || typeof item.agentId !== "string") continue;
      const normalized = { ...item, task: item.task ?? item.prompt ?? "", dependsOn: item.dependsOn ?? [] };
      const index = state.plan.findIndex(task => task.id === item.id);
      if (index < 0) state.plan.push(normalized); else state.plan[index] = normalized;
      state.taskStatus[item.id] ??= ["complete", "failed", "aborted"].includes(run.status) ? "skipped" : "pending";
    }
  }
  for (const state of Object.values(states)) {
    const results = db.prepare("SELECT task_id,status,child_run_id,summary FROM conductor_task_results WHERE conductor_run_id=?").all(state.runId) as Array<{ task_id: string; status: string; child_run_id: string | null; summary: string | null }>;
    let hasExecution = results.length > 0;
    for (const task of state.plan) {
      const attempts = listTaskAttempts(state.runId, task.id).sort((a, b) =>
        (planOrder.get(a.planId) ?? -1) - (planOrder.get(b.planId) ?? -1) || a.attempt - b.attempt || a.createdAt - b.createdAt);
      hasExecution ||= attempts.length > 0;
      state.attemptIdsByTask[task.id] = attempts.map(attempt => attempt.id);
      for (const attempt of attempts) {
        const verdicts = listCriterionVerdicts(attempt.id);
        state.evidenceCountByAttempt[attempt.id] = listEvidenceForAttempt(attempt.id).length;
        state.verdictSummaryByAttempt[attempt.id] = { passed: verdicts.filter(item => item.status === "passed").length,
          failed: verdicts.filter(item => item.status === "failed").length, missing: verdicts.filter(item => item.status === "missing").length,
          needsReview: verdicts.filter(item => item.status === "needs_review").length };
        const snapshot = attempt.contextSnapshotId ? getContextSnapshot(attempt.contextSnapshotId) : undefined;
        if (snapshot) {
          let manifest: Array<{ included?: boolean }> = [];
          try { manifest = JSON.parse(snapshot.manifestJson); } catch { /* Old malformed traces have no display summary. */ }
          state.contextSummaryByAttempt[attempt.id] = { tokenEstimate: snapshot.tokenEstimate,
            includedCount: manifest.filter(item => item.included).length, omittedCount: manifest.filter(item => !item.included).length };
        }
      }
      const current = attempts.at(-1);
      if (current) {
        state.activeAttemptByTask[task.id] = current.id;
        state.attempts[task.id] = current.attempt;
        task.agentId = current.agentId;
        if (current.childRunId) state.childRunIds[task.id] = current.childRunId;
        state.taskStatus[task.id] = current.executionStatus === "running" ? "running" : current.executionStatus === "queued" ? "pending"
          : current.executionStatus === "aborted" ? "aborted" : current.verificationStatus === "verified" ? "complete" : "failed";
        state.verificationStatusByTask[task.id] = current.verificationStatus === "verified" ? "verified" : current.verificationStatus === "needs_review" ? "needs_review"
          : current.verificationStatus === "rejected" ? "rejected" : "checking";
      }
      const result = results.find(result => result.task_id === task.id && (!current || result.child_run_id === current.childRunId));
      if (result && ["complete", "failed", "blocked", "skipped", "aborted"].includes(result.status)) {
        state.taskStatus[task.id] = result.status as DispatchState["taskStatus"][string];
        if (result.status !== "complete" && result.summary) state.errors[task.id] = result.summary;
      }
    }
    if (!hasExecution) delete states[state.runId];
  }
  return states;
}
