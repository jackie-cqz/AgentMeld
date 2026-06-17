"use client";

import { AlertTriangle, Check, FileText, Terminal, X, Network } from "lucide-react";
import { useAppStore } from "@/stores/app-store";
import type { PendingWrite, PendingBashCommand, PendingDispatchPlan } from "@/shared/types";

export function PendingApprovalPanel() {
  const activeConversationId = useAppStore((s) => s.activeConversationId);
  const pendingWrites = useAppStore((s) => s.pendingWrites);
  const pendingBashCommands = useAppStore((s) => s.pendingBashCommands);
  const pendingDispatchPlans = useAppStore((s) => s.pendingDispatchPlans);

  if (!activeConversationId) return null;

  const writes = Object.values(pendingWrites).filter(
    (w) => w.conversationId === activeConversationId
  );
  const bashes = Object.values(pendingBashCommands).filter(
    (b) => b.conversationId === activeConversationId
  );
  const plans = Object.values(pendingDispatchPlans).filter(
    (p) => p.conversationId === activeConversationId
  );

  if (writes.length === 0 && bashes.length === 0 && plans.length === 0) return null;

  return (
    <div className="shrink-0 border-t border-amber-200 bg-amber-50 px-6 py-3">
      <div className="mx-auto max-w-3xl space-y-2">
        {plans.map((plan) => (
          <DispatchPlanCard key={plan.id} plan={plan} />
        ))}
        {writes.map((write) => (
          <PendingWriteCard key={write.id} write={write} />
        ))}
        {bashes.map((bash) => (
          <PendingBashCard key={bash.id} bash={bash} />
        ))}
      </div>
    </div>
  );
}

function PendingWriteCard({ write }: { write: PendingWrite }) {
  const handleResolve = async (approved: boolean) => {
    await fetch(`/api/pending-writes/${write.id}/resolve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ approved })
    });
  };

  return (
    <div className="flex items-start gap-3 rounded-md border border-amber-300 bg-white p-3 shadow-sm">
      <FileText className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium text-stone-900">文件写入审批</div>
        <div className="mt-1 text-xs text-stone-600 font-mono truncate">{write.path}</div>
        {write.oldContent !== null ? (
          <div className="mt-2 rounded border border-stone-200 bg-stone-50 p-2 text-xs text-stone-700 max-h-24 overflow-auto">
            <pre className="whitespace-pre-wrap">{write.newContent.slice(0, 500)}</pre>
          </div>
        ) : (
          <div className="mt-2 text-xs text-stone-500">新建文件 · {write.newContent.length} 字符</div>
        )}
      </div>
      <div className="flex shrink-0 gap-1">
        <button
          onClick={() => handleResolve(true)}
          className="grid h-8 w-8 place-items-center rounded-md bg-emerald-100 text-emerald-700 hover:bg-emerald-200"
          title="批准"
        >
          <Check className="h-4 w-4" />
        </button>
        <button
          onClick={() => handleResolve(false)}
          className="grid h-8 w-8 place-items-center rounded-md bg-red-100 text-red-700 hover:bg-red-200"
          title="拒绝"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}

function PendingBashCard({ bash }: { bash: PendingBashCommand }) {
  const handleResolve = async (approved: boolean) => {
    await fetch(`/api/pending-bash/${bash.id}/resolve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ approved })
    });
  };

  return (
    <div className="flex items-start gap-3 rounded-md border border-amber-300 bg-white p-3 shadow-sm">
      <Terminal className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium text-stone-900">命令执行审批</div>
        <div className="mt-1 text-xs text-stone-600 font-mono truncate">{bash.command}</div>
        <div className="mt-1 text-xs text-stone-500">
          cwd: {bash.cwd} · Agent: {bash.agentId}
        </div>
        {bash.reason ? (
          <div className="mt-1 text-xs text-stone-500">原因: {bash.reason}</div>
        ) : null}
      </div>
      <div className="flex shrink-0 gap-1">
        <button
          onClick={() => handleResolve(true)}
          className="grid h-8 w-8 place-items-center rounded-md bg-emerald-100 text-emerald-700 hover:bg-emerald-200"
          title="批准执行"
        >
          <Check className="h-4 w-4" />
        </button>
        <button
          onClick={() => handleResolve(false)}
          className="grid h-8 w-8 place-items-center rounded-md bg-red-100 text-red-700 hover:bg-red-200"
          title="拒绝执行"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}

function DispatchPlanCard({ plan }: { plan: PendingDispatchPlan }) {
  const agents = useAppStore((s) => s.agents);
  const handleResolve = async (action: "approve" | "reject") => {
    await fetch(`/api/dispatch-plans/${plan.id}/resolve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action })
    });
  };

  return (
    <div className="flex items-start gap-3 rounded-md border border-blue-300 bg-white p-3 shadow-sm">
      <Network className="mt-0.5 h-4 w-4 shrink-0 text-blue-600" />
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium text-stone-900">编排计划待审批</div>
        <div className="mt-2 space-y-1">
          {plan.plan.map((item) => {
            const agent = agents[item.agentId];
            return (
              <div key={item.id} className="flex items-center gap-2 text-xs text-stone-600">
                <span className="font-mono text-stone-400">{item.id}</span>
                <span>{item.task.slice(0, 60)}</span>
                <span className="text-stone-400">→</span>
                <span className="font-medium">{agent?.name ?? item.agentId}</span>
                {item.dependsOn.length > 0 ? (
                  <span className="text-stone-400">depends: {item.dependsOn.join(", ")}</span>
                ) : null}
              </div>
            );
          })}
        </div>
      </div>
      <div className="flex shrink-0 gap-1">
        <button
          onClick={() => handleResolve("approve")}
          className="grid h-8 w-8 place-items-center rounded-md bg-emerald-100 text-emerald-700 hover:bg-emerald-200"
          title="批准执行"
        >
          <Check className="h-4 w-4" />
        </button>
        <button
          onClick={() => handleResolve("reject")}
          className="grid h-8 w-8 place-items-center rounded-md bg-red-100 text-red-700 hover:bg-red-200"
          title="拒绝"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}
