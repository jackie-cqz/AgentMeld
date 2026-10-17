"use client";

import { Check, CircleHelp, Clock, Loader2, MessageSquare, Play, Square, X } from "lucide-react";
import { useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { useAppStore } from "@/stores/app-store";
import { requestJson } from "@/lib/request-json";
import { Select } from "@/components/ui/select";
import type { CollaborationAction, CollaborationTurn, CollaborationTurnStatus } from "@/shared/collaboration-types";

const LABELS: Record<CollaborationTurnStatus, string> = {
  received: "已接收", classifying: "判断中", needs_confirmation: "待确认", queued: "已排队", applied: "已生效", rejected: "未生效", cancelled: "已取消", resolved: "已确认",
};

export function MessageTurnStatus({ messageId }: { messageId: string }) {
  const turns = useAppStore(useShallow(state => Object.values(state.collaborationTurns).filter(turn => turn.messageId === messageId).sort((a, b) => a.createdAt - b.createdAt)));
  if (!turns.length) return null;
  return <div className="mt-1 flex max-w-full flex-col items-end gap-1 text-[11px] text-[var(--ui-muted)]" aria-label="消息处理状态">
    {turns.map(turn => <TurnStatus key={turn.id} turn={turn} />)}
  </div>;
}

function TurnStatus({ turn }: { turn: CollaborationTurn }) {
  const agents = useAppStore(state => state.agents);
  const related = useAppStore(useShallow(state => Object.values(state.runs).filter(run => run.conversationId === turn.conversationId && run.id !== turn.runId &&
    (agents[turn.agentId]?.isConductor || run.agentId === turn.agentId) && (run.status === "running" || run.status === "queued"))));
  const loadBootstrap = useAppStore(state => state.loadBootstrap);
  const [target, setTarget] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const selected = target || (related.length === 1 ? related[0].id : "");
  const act = async (action: CollaborationAction) => {
    setBusy(true); setError(null);
    try {
      await requestJson(`/api/collaboration-turns/${turn.id}/resolve`, { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, targetRunId: ["progress", "supplement", "correction", "cancel"].includes(action) ? selected || undefined : undefined }) });
      await loadBootstrap();
    } catch (failure) { setError(failure instanceof Error ? failure.message : "确认失败。"); }
    finally { setBusy(false); }
  };
  const cancel = async () => {
    setBusy(true); setError(null);
    try { await requestJson(`/api/runs/${turn.runId}/abort`, { method: "POST" }); }
    catch (failure) { setError(failure instanceof Error ? failure.message : "取消失败。"); }
    finally { setBusy(false); }
  };
  return <div className="flex max-w-full flex-col items-end gap-1">
    <span className="flex max-w-full items-center gap-1.5" title={turn.reason ?? LABELS[turn.status]}>
      {turn.status === "classifying" ? <Loader2 size={11} className="shrink-0 animate-spin" /> : turn.status === "applied" || turn.status === "resolved" ? <Check size={11} className="shrink-0" /> : turn.status === "needs_confirmation" ? <CircleHelp size={11} className="shrink-0" /> : turn.status === "rejected" || turn.status === "cancelled" ? <X size={11} className="shrink-0" /> : <Clock size={11} className="shrink-0" />}
      <span className="min-w-0 truncate">{agents[turn.agentId]?.name ?? "Agent"} · {LABELS[turn.status]}</span>
      {["received", "classifying", "queued"].includes(turn.status) ? <button type="button" disabled={busy} onClick={() => void cancel()} title="取消这条消息的处理" className="grid h-5 w-5 shrink-0 place-items-center rounded hover:bg-[var(--ui-subtle)]"><Square size={10} /></button> : null}
    </span>
    {turn.status === "needs_confirmation" ? <div className="flex max-w-full flex-wrap items-center justify-end gap-1.5">
      <button type="button" disabled={busy} onClick={() => void act("discussion")} className="inline-flex items-center gap-1 rounded border border-[var(--ui-border)] px-2 py-1"><MessageSquare size={11} />继续讨论</button>
      <button type="button" disabled={busy} onClick={() => void act("new_task")} className="inline-flex items-center gap-1 rounded border border-[var(--ui-border)] px-2 py-1"><Play size={11} />作为任务执行</button>
      {related.length ? <>
        <Select aria-label="关联运行" size="sm" value={selected} onChange={setTarget}
          options={[
            { value: "", label: "选择关联运行" },
            ...related.map(run => ({ value: run.id, label: `${agents[run.agentId]?.name ?? "Agent"} · ${new Date(run.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` }))
          ]} />
        <button type="button" disabled={busy || !selected} onClick={() => void act("supplement")} className="rounded border border-[var(--ui-border)] px-2 py-1">补充</button>
        <button type="button" disabled={busy || !selected} onClick={() => void act("cancel")} className="rounded border border-[var(--ui-border)] px-2 py-1">停止</button>
      </> : null}
    </div> : null}
    {error ? <span role="alert" className="max-w-full break-words text-red-600">{error}</span> : null}
  </div>;
}

export function RunStageBadge({ runId }: { runId: string }) {
  const label = useAppStore(state => {
    const run = state.runs[runId];
    if (!run || run.status !== "running") return null;
    if (Object.values(state.pendingDispatchPlans).some(item => item.runId === runId)) return "等待计划审批";
    if (Object.values(state.pendingWrites).some(item => item.runId === runId)) return "等待文件审批";
    if (Object.values(state.pendingBashCommands).some(item => item.runId === runId)) return "等待命令审批";
    if (Object.values(state.pendingQuestions).some(item => item.runId === runId)) return "等待回答";
    if (Object.values(state.consultations).some(item => item.sourceRunId === runId && ["requested", "running"].includes(item.status))) return "等待同事";
    return ({ discussion: "讨论中", "execution.queued": "排队中", execution: "执行中", dispatch: "协作执行中", recovery: "恢复中", aggregate: "汇总中", planning: "规划中", handoff: "任务交接中" } as Record<string, string>)[run.stage ?? ""] ?? null;
  });
  return label ? <span className="max-w-32 truncate text-[11px] font-normal text-[var(--ui-muted)]">{label}</span> : null;
}
