"use client";

import {
  Ban,
  CheckCircle2,
  Circle,
  Clock3,
  GitBranch,
  Loader2,
  RotateCcw,
  XCircle
} from "lucide-react";
import { useAppStore } from "@/stores/app-store";
import type { DispatchState } from "@/stores/store-types";

export function DispatchProgress({ messageId }: { messageId: string }) {
  const dispatch = useAppStore((state) =>
    Object.values(state.dispatchesByRunId).find((item) => item.messageId === messageId) ?? null
  );

  if (!dispatch || dispatch.plan.length === 0) return null;

  const completeCount = Object.values(dispatch.taskStatus).filter((status) => status === "complete").length;

  return (
    <section className="mt-3 rounded-lg border border-blue-200 bg-blue-50/70 p-3">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-sm font-medium text-blue-950">
          <GitBranch className="h-4 w-4 text-blue-600" />
          调度进度
        </div>
        <span className="text-xs text-blue-700">
          {completeCount}/{dispatch.plan.length} 完成
        </span>
      </div>
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
    <div className="rounded-md border border-blue-100 bg-white px-3 py-2">
      <div className="flex items-start gap-2">
        <StatusIcon status={status} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-[11px] text-slate-400">{task.id}</span>
            <span className="text-xs font-medium text-slate-800">{agent?.name ?? task.agentId}</span>
            <StatusLabel status={status} />
          </div>
          <p className="mt-1 text-xs leading-5 text-slate-600">{task.task}</p>
          {task.dependsOn.length > 0 ? (
            <div className="mt-1 flex flex-wrap gap-1">
              {task.dependsOn.map((dependency) => (
                <span key={dependency} className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] text-slate-500">
                  依赖 {dependency}
                </span>
              ))}
            </div>
          ) : null}
          <div className="mt-1 flex flex-wrap gap-1">
            {task.maxAttempts && task.maxAttempts > 1 ? (
              <span className="rounded bg-blue-50 px-1.5 py-0.5 text-[10px] text-blue-600">
                最多 {task.maxAttempts} 次
              </span>
            ) : null}
            {task.expectedOutputs?.map((output) => (
              <span key={output.id} className="rounded bg-emerald-50 px-1.5 py-0.5 text-[10px] text-emerald-700">
                产物 {output.id} · {output.type}
              </span>
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
  return <Circle className="mt-0.5 h-4 w-4 shrink-0 text-slate-300" />;
}

function StatusLabel({ status }: { status: DispatchState["taskStatus"][string] }) {
  const labels = {
    pending: "等待",
    running: "执行中",
    complete: "完成",
    failed: "失败",
    aborted: "已中止",
    skipped: "已跳过"
  };
  return (
    <span className="flex items-center gap-1 rounded-full bg-slate-100 px-2 py-0.5 text-[10px] text-slate-600">
      {status === "pending" ? <Clock3 className="h-3 w-3" /> : null}
      {labels[status]}
    </span>
  );
}
