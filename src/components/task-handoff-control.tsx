"use client";

import { ArrowRight, ArrowRightLeft, Check, Loader2, X } from "lucide-react";
import { useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { useAppStore } from "@/stores/app-store";
import { requestJson } from "@/lib/request-json";
import { Select } from "@/components/ui/select";
import type { TaskHandoff } from "@/shared/collaboration-types";

export function TaskHandoffControl({ runId, taskId, attemptId, sourceAgentId, verified }: {
  runId: string; taskId: string; attemptId?: string; sourceAgentId: string; verified: boolean;
}) {
  const agents = useAppStore(state => state.agents);
  const run = useAppStore(state => state.runs[runId]);
  const conversation = useAppStore(state => run ? state.conversations[run.conversationId] : undefined);
  const handoffs = useAppStore(useShallow(state => Object.values(state.handoffs).filter(item => item.taskId === taskId &&
    (item.coordinatorRunId === runId || state.runs[item.sourceRunId]?.parentRunId === runId)).sort((a, b) => a.createdAt - b.createdAt)));
  const [open, setOpen] = useState(false);
  const [target, setTarget] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const candidates = (conversation?.agentIds ?? []).map(id => agents[id]).filter(agent => agent && !agent.isConductor && agent.adapterName === "pi" && agent.id !== sourceAgentId);
  const selected = target || candidates[0]?.id || "";
  const create = async () => {
    setBusy(true); setError(null);
    try {
      const handoff = await requestJson<TaskHandoff>("/api/task-handoffs", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sourceAttemptId: attemptId, targetAgentId: selected }) });
      useAppStore.setState(state => ({ handoffs: { ...state.handoffs, [handoff.id]: handoff } }));
      setOpen(false);
    } catch (failure) { setError(failure instanceof Error ? failure.message : "无法创建交接。"); }
    finally { setBusy(false); }
  };
  return <div className="mt-2 border-t border-[var(--ui-border)] pt-2 text-xs">
    {handoffs.map(handoff => <HandoffRow key={handoff.id} handoff={handoff} />)}
    {attemptId && !verified && candidates.length > 0 && !handoffs.some(item => item.sourceAttemptId === attemptId && (item.status === "proposed" || item.status === "accepted" && (item.targetAttemptId !== null || ["stopping", "running", "complete"].includes(item.executionStatus)))) ? <>
      <button type="button" onClick={() => setOpen(!open)} className="inline-flex items-center gap-1 text-[var(--ui-muted)] hover:text-[var(--ui-text)]"><ArrowRightLeft size={12} />交给同事</button>
      {open ? <div className="mt-2 flex flex-wrap items-center gap-2">
        <Select aria-label="接手 Agent" size="sm" value={selected} onChange={setTarget}
          options={candidates.map(agent => ({ value: agent.id, label: agent.name }))} />
        <button type="button" disabled={!selected || busy} onClick={() => void create()} className="inline-flex items-center gap-1 rounded border border-[var(--ui-border)] px-2 py-1">{busy ? <Loader2 size={12} className="animate-spin" /> : <ArrowRightLeft size={12} />}生成交接卡片</button>
      </div> : null}
    </> : null}
    {error ? <p role="alert" className="mt-1 break-words text-red-600">{error}</p> : null}
  </div>;
}

function HandoffRow({ handoff }: { handoff: TaskHandoff }) {
  const agents = useAppStore(state => state.agents);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [details, setDetails] = useState<{ criteria: string[]; files: string[]; evidenceCount: number; failure: string | null } | null>(null);
  const decide = async (decision: "accept" | "decline" | "cancel") => {
    setBusy(true); setError(null);
    try {
      const next = await requestJson<TaskHandoff>(`/api/task-handoffs/${handoff.id}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ decision }) });
      useAppStore.setState(state => {
        const previous = state.handoffs[next.id];
        return !previous || previous.updatedAt <= next.updatedAt ? { handoffs: { ...state.handoffs, [next.id]: next } } : {};
      });
    } catch (failure) { setError(failure instanceof Error ? failure.message : "交接操作失败。"); }
    finally { setBusy(false); }
  };
  const inspect = async () => {
    if (details) { setDetails(null); return; }
    try {
      const data = await requestJson<{ package: { task: { acceptanceCriteria: string[] }; files: Array<{ path: string }>; evidence: unknown[]; failure: string | null } }>(`/api/task-handoffs/${handoff.id}`);
      setDetails({ criteria: data.package.task.acceptanceCriteria, files: data.package.files.map(file => file.path), evidenceCount: data.package.evidence.length, failure: data.package.failure });
    } catch (failure) { setError(failure instanceof Error ? failure.message : "无法查看交接内容。"); }
  };
  const status = handoff.status === "accepted" ? ({ not_started: "待接手", stopping: "等待原执行停止", running: handoff.targetRunId ? "接手执行中" : "正在验证交接条件", complete: "接手完成", failed: "接手失败", interrupted: "接手中断" })[handoff.executionStatus]
    : ({ proposed: "待确认交接", declined: "已拒绝", cancelled: "已取消", expired: "已过期" })[handoff.status];
  return <div className="mb-2 min-w-0 border-l-2 border-[var(--ui-border)] pl-2.5">
    <div className="flex flex-wrap items-center gap-1.5">
      <ArrowRightLeft size={12} className="shrink-0" /><span>{agents[handoff.sourceAgentId]?.name ?? "原执行者"}</span><ArrowRight size={12} /><span>{agents[handoff.targetAgentId]?.name ?? "接手者"}</span>
      <span className="text-[var(--ui-muted)]">· {status}</span>
      <button type="button" onClick={() => void inspect()} className="ml-auto text-[var(--ui-muted)] underline underline-offset-2">{details ? "收起" : "交接内容"}</button>
    </div>
    {details ? <div className="mt-2 space-y-1 break-words text-[var(--ui-muted)]">
      <p>验收：{details.criteria.join("；") || "保留原任务的证据契约"}</p>
      {details.files.length ? <p>文件：{details.files.join("、")}</p> : null}
      <p>历史证据：{details.evidenceCount} 项</p>{details.failure ? <p className="line-clamp-3">失败记录：{details.failure}</p> : null}
    </div> : null}
    {handoff.status === "proposed" ? <div className="mt-2 flex flex-wrap gap-2">
      <button type="button" disabled={busy} onClick={() => void decide("accept")} className="inline-flex items-center gap-1 rounded border border-[var(--ui-border)] px-2 py-1">{busy ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}确认接手</button>
      <button type="button" disabled={busy} onClick={() => void decide("decline")} className="inline-flex items-center gap-1 px-1 py-1"><X size={12} />拒绝</button>
      <button type="button" disabled={busy} onClick={() => void decide("cancel")} className="px-1 py-1 text-[var(--ui-muted)]">取消</button>
    </div> : null}
    {handoff.error || error ? <p role="alert" className="mt-1 break-words text-red-600">{error ?? handoff.error}</p> : null}
  </div>;
}
