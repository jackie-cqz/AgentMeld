"use client";

import {
  Ban, CheckCircle2, Circle, Clock3, GitBranch,
  Loader2, RotateCcw, XCircle, AlertTriangle, RefreshCw
} from "lucide-react";
import { useAppStore } from "@/stores/app-store";
import type { DispatchState } from "@/stores/store-types";
import type { ReactElement } from "react";

export function DispatchProgress({ messageId }: { messageId: string }) {
  const dispatch = useAppStore((state) =>
    Object.values(state.dispatchesByRunId).find((item) => item.messageId === messageId) ?? null
  );

  if (!dispatch || dispatch.plan.length === 0) return null;

  const total = dispatch.plan.length;
  const complete = Object.values(dispatch.taskStatus).filter((s) => s === "complete").length;
  const failed = Object.values(dispatch.taskStatus).filter((s) => s === "failed" || s === "aborted" || s === "blocked").length;
  const skipped = Object.values(dispatch.taskStatus).filter((s) => s === "skipped").length;
  const running = Object.values(dispatch.taskStatus).filter((s) => s === "running").length;

  // Determine aggregate status
  let aggStatus: { label: string; color: string; icon: ReactElement } = { label: "执行中", color: "text-blue-700", icon: <Loader2 className="h-4 w-4 animate-spin text-blue-600" /> };
  const terminal = complete + failed + skipped;
  if (failed > 0) aggStatus = { label: terminal === total ? "执行结束，存在失败" : "部分失败", color: "text-red-700", icon: <AlertTriangle className="h-4 w-4 text-red-600" /> };
  else if (terminal === total && skipped > 0) aggStatus = { label: "部分完成", color: "text-amber-700", icon: <AlertTriangle className="h-4 w-4 text-amber-600" /> };
  else if (complete === total) aggStatus = { label: "全部完成", color: "text-emerald-700", icon: <CheckCircle2 className="h-4 w-4 text-emerald-600" /> };

  return (
    <section className="mt-3 rounded-lg border border-blue-200 bg-blue-50/70 p-3">
      <header className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-sm font-medium text-blue-950">
          <GitBranch className="h-4 w-4 text-blue-600" />
          调度进度
        </div>
        <div className="flex items-center gap-2">
          <span className={`flex items-center gap-1 text-xs font-medium ${aggStatus.color}`}>
            {aggStatus.icon}{aggStatus.label}
          </span>
          <span className="text-xs text-slate-500">
            {complete}/{total} · ❌{failed} · ⏭{skipped}
            {running > 0 ? ` · ⏳${running}` : ""}
          </span>
        </div>
      </header>
      <div className="mt-3 space-y-2">
        {dispatch.plan.map((task) => (
          <DispatchTaskRow key={task.id} dispatch={dispatch} taskId={task.id} />
        ))}
      </div>
    </section>
  );
}

function DispatchTaskRow({ dispatch, taskId }: { dispatch: DispatchState; taskId: string }) {
  const agents = useAppStore((state) => state.agents);
  const task = dispatch.plan.find((item) => item.id === taskId);
  if (!task) return null;
  const status = dispatch.taskStatus[taskId] ?? "pending";
  const agent = agents[task.agentId];

  return (
    <div className={`rounded-md border px-3 py-2 ${
      status === "failed" || status === "aborted" ? "border-red-100 bg-red-50/50" :
      status === "complete" ? "border-emerald-100 bg-white" :
      status === "running" ? "border-blue-200 bg-white" :
      "border-blue-100 bg-white"
    }`}>
      <div className="flex items-start gap-2">
        <StatusIcon status={status} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-[11px] text-slate-400">{task.id}</span>
            <span className="text-xs font-medium text-slate-800">{agent?.name ?? task.agentId}</span>
            <StatusLabel status={status} />
            {status === "running" ? (
              <span className="flex items-center gap-0.5 text-[10px] text-blue-600">
                <RefreshCw className="h-3 w-3" />第{dispatch.attempts[taskId] ?? 1}次
              </span>
            ) : null}
          </div>
          <p className="mt-1 line-clamp-2 text-xs leading-5 text-slate-600">{task.task}</p>
          {task.dependsOn.length > 0 ? (
            <div className="mt-1 flex flex-wrap gap-1">
              {task.dependsOn.map((dep) => (
                <span key={dep} className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] text-slate-500">依赖 {dep}</span>
              ))}
            </div>
          ) : null}
          <div className="mt-1 flex flex-wrap gap-1">
            {task.acceptanceCriteria?.map((criterion, idx) => (
              <span key={idx} className="rounded bg-purple-50 px-1.5 py-0.5 text-[10px] text-purple-700">验收: {criterion}</span>
            ))}
            {task.expectedOutputs?.map((output) => (
              <span key={output.id} className="rounded bg-emerald-50 px-1.5 py-0.5 text-[10px] text-emerald-700">{output.id} · {output.type}</span>
            ))}
            {task.targetPaths?.map((path) => (
              <span key={path} className="rounded bg-amber-50 px-1.5 py-0.5 font-mono text-[10px] text-amber-700">{path}</span>
            ))}
          </div>
          {dispatch.errors[taskId] ? (
            <p className="mt-1 text-xs text-red-600">{dispatch.errors[taskId]}</p>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function StatusIcon({ status }: { status: DispatchState["taskStatus"][string] }) {
  if (status === "running") return <Loader2 className="mt-0.5 h-4 w-4 shrink-0 animate-spin text-blue-600" />;
  if (status === "complete") return <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" />;
  if (status === "failed") return <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-red-600" />;
  if (status === "aborted") return <Ban className="mt-0.5 h-4 w-4 shrink-0 text-slate-500" />;
  if (status === "skipped") return <RotateCcw className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />;
  if (status === "blocked") return <Ban className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />;
  return <Circle className="mt-0.5 h-4 w-4 shrink-0 text-slate-300" />;
}

function StatusLabel({ status }: { status: DispatchState["taskStatus"][string] }) {
  const labels: Record<string, string> = { pending: "等待", running: "执行中", complete: "完成", failed: "失败", aborted: "已中止", skipped: "已跳过", blocked: "依赖阻塞" };
  return (
    <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] text-slate-600">
      {status === "pending" ? <Clock3 className="mr-0.5 inline h-3 w-3" /> : null}
      {labels[status] ?? status}
    </span>
  );
}
